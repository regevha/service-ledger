"""Tests for the race-handling branches: the `except IntegrityError` blocks in
the routers and the worker's re-checks after its slow Claude call.

Each router check ("does this serial / template already exist?") runs before
the commit, so the only way to reach the handler is for another request to win
the race in between. These tests make that happen for real rather than
mocking the exception: a hook runs on its own connection and commits the
competing write just before the request's own commit, so the database's own
unique index or foreign key is what rejects the request — the same thing that
happens in production when two requests collide.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app import models
from app.db import get_db
from app.main import app
from tests.conftest import TestSessionLocal

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")
FIELDS = [{"name": "note", "type": "text"}]


@pytest.fixture()
def race(client):
    """`race(fn)` arms a one-shot hook: the next commit made by a request's
    session first runs `fn()` (which should use its own session and commit),
    then carries on with the request's own commit."""
    state = {"hook": None}

    def _override_get_db():
        db = TestSessionLocal()
        real_commit = db.commit

        def commit():
            hook, state["hook"] = state["hook"], None
            if hook:
                hook()
            real_commit()

        db.commit = commit
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db

    def arm(fn):
        state["hook"] = fn

    return arm


def _in_own_session(write):
    def hook():
        with TestSessionLocal() as other:
            write(other)
            other.commit()

    return hook


def _instrument(serial: str, model: str = "TestModel") -> models.Instrument:
    return models.Instrument(name=serial, model=model, serial_number=serial)


# ---------- instruments ----------


def test_create_instrument_losing_a_serial_race_is_a_409(client, race):
    race(_in_own_session(lambda s: s.add(_instrument("RACE-1"))))

    resp = client.post("/instruments", json={"name": "Mine", "model": "TestModel", "serial_number": "RACE-1"})

    assert resp.status_code == 409
    assert "serial" in resp.json()["detail"].lower()
    assert len([i for i in client.get("/instruments").json() if i["serial_number"] == "RACE-1"]) == 1


def test_edit_instrument_losing_a_serial_race_is_a_409(client, race):
    mine = client.post("/instruments", json={"name": "Mine", "model": "TestModel", "serial_number": "MINE-1"}).json()
    race(_in_own_session(lambda s: s.add(_instrument("RACE-2"))))

    resp = client.patch(f"/instruments/{mine['id']}", json={"serial_number": "RACE-2"})

    assert resp.status_code == 409
    after = next(i for i in client.get("/instruments").json() if i["id"] == mine["id"])
    assert after["serial_number"] == "MINE-1"


# ---------- report templates ----------


def test_create_template_losing_a_collision_race_is_a_409(client, race):
    def competing(s):
        s.add(models.ReportTemplate(report_type=models.ReportType.repair, model="RaceModel", field_schema={"fields": []}))

    race(_in_own_session(competing))

    resp = client.post("/report-templates", json={"report_type": "repair", "model": "RaceModel", "fields": FIELDS})

    assert resp.status_code == 409
    rows = [t for t in client.get("/report-templates/all").json() if t["model"] == "RaceModel"]
    assert len(rows) == 1 and rows[0]["field_schema"]["fields"] == []  # the winner's row, not ours


def test_edit_template_losing_a_collision_race_is_a_409(client, race):
    mine = client.post("/report-templates", json={"report_type": "repair", "model": "Mine", "fields": FIELDS}).json()

    def competing(s):
        s.add(models.ReportTemplate(report_type=models.ReportType.repair, model="Taken", field_schema={"fields": []}))

    race(_in_own_session(competing))

    resp = client.patch(f"/report-templates/{mine['id']}", json={"model": "Taken"})

    assert resp.status_code == 409
    assert client.get(f"/report-templates/{mine['id']}").json()["model"] == "Mine"


def test_delete_template_that_gains_a_report_mid_request_is_a_409(client, race):
    mine = client.post("/report-templates", json={"report_type": "repair", "model": "Mine", "fields": FIELDS}).json()
    race(_in_own_session(lambda s: s.add(models.Report(template_id=mine["id"]))))

    resp = client.delete(f"/report-templates/{mine['id']}")

    assert resp.status_code == 409
    assert "attached to this template just now" in resp.json()["detail"]
    assert client.get(f"/report-templates/{mine['id']}").status_code == 200  # still there, and still referenced


# ---------- confirming a template ----------


def test_confirming_a_template_that_is_deleted_mid_request_is_a_409(client, race):
    instrument = client.post("/instruments", json={"name": "I", "model": "TestModel", "serial_number": "CONF-1"}).json()
    template = client.post("/report-templates", json={"report_type": "repair", "model": "Doomed", "fields": FIELDS}).json()
    report = client.post("/reports", json={}).json()

    def delete_template(s):
        s.delete(s.get(models.ReportTemplate, template["id"]))

    race(_in_own_session(delete_template))

    resp = client.patch(
        f"/reports/{report['id']}/template", json={"instrument_id": instrument["id"], "template_id": template["id"]}
    )

    assert resp.status_code == 409
    assert "just deleted" in resp.json()["detail"]
    after = client.get(f"/reports/{report['id']}").json()
    assert after["template_id"] is None and after["status"] == "draft"


# ---------- worker: re-checks after the slow Claude call ----------


def _classified_report(client, run_worker, monkeypatch):
    from tests.test_regressions import _confident

    _confident(monkeypatch)
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    return report, attachment


def test_report_finalized_while_classification_runs_is_not_overwritten(client, run_worker, monkeypatch):
    """The classify twin of the extraction regression test: the report is
    finalized while Claude is still classifying, so the worker must discard
    the result instead of reverting status and re-pointing the template."""
    report, attachment = _classified_report(client, run_worker, monkeypatch)
    job = client.post(f"/attachments/{attachment['id']}/classify").json()

    from app.worker import run_classify as real_run_classify

    def _finalize(s):
        # Straight in the database: the finalize endpoint only accepts a report
        # that has been extracted, which this one has not (it is mid-classify).
        row = s.get(models.Report, report["id"])
        row.status = models.ReportStatus.finalized
        row.finalized_at = datetime.now(timezone.utc)

    def _classify_while_technician_finalizes(db, att):
        result = real_run_classify(db, att)
        _in_own_session(_finalize)()
        return result

    monkeypatch.setattr("app.worker.run_classify", _classify_while_technician_finalizes)
    run_worker()

    after = client.get(f"/reports/{report['id']}").json()
    assert after["status"] == "finalized"
    assert after["instrument_id"] is None and after["template_id"] is None
    failed = client.get(f"/extraction-jobs/{job['id']}").json()
    assert failed["status"] == "failed"
    assert "finalized" in failed["error_message"]


def test_extract_job_for_a_report_finalized_before_pickup_never_calls_claude(client, run_worker, monkeypatch):
    from tests.test_regressions import _extracted_report

    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    job = client.post(f"/attachments/{attachment['id']}/extract").json()
    assert client.post(f"/reports/{report['id']}/finalize").status_code == 200

    calls = []
    monkeypatch.setattr("app.worker.run_extract", lambda *a, **k: calls.append(a))
    run_worker()

    assert calls == []  # the cheap early-out fired, so no API call was spent
    failed = client.get(f"/extraction-jobs/{job['id']}").json()
    assert failed["status"] == "failed"
    assert "finalized" in failed["error_message"]


def test_extract_job_whose_report_lost_its_template_fails_cleanly(client, run_worker, monkeypatch):
    from tests.test_regressions import _extracted_report

    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    job = client.post(f"/attachments/{attachment['id']}/extract").json()
    with TestSessionLocal() as db:
        db.get(models.Report, report["id"]).template_id = None
        db.commit()

    run_worker()

    failed = client.get(f"/extraction-jobs/{job['id']}").json()
    assert failed["status"] == "failed"
    assert "no resolved instrument/template" in failed["error_message"]


# ---------- worker: the main loop ----------


class _StopLoop(Exception):
    pass


def test_run_forever_recovers_orphans_then_polls_and_sleeps_when_idle(client, monkeypatch):
    from app import worker

    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    with TestSessionLocal() as db:
        db.add(models.ExtractionJob(attachment_id=attachment["id"], kind=models.ExtractionJobKind.classify,
                                    status=models.ExtractionJobStatus.classifying))
        db.commit()

    ticks = iter([True, False])  # a job was processed, then the queue was empty
    sleeps = []

    def fake_tick():
        try:
            return next(ticks)
        except StopIteration:
            raise _StopLoop from None

    monkeypatch.setattr(worker, "_worker_tick", fake_tick)
    monkeypatch.setattr(worker.time, "sleep", sleeps.append)
    monkeypatch.setattr(worker, "SessionLocal", TestSessionLocal)

    with pytest.raises(_StopLoop):
        worker.run_forever()

    assert sleeps == [worker.settings.worker_poll_interval_seconds]  # slept once, only after the idle tick
    with TestSessionLocal() as db:
        job = db.query(models.ExtractionJob).one()
        assert job.status == models.ExtractionJobStatus.failed
        assert "Worker restarted" in job.error_message
