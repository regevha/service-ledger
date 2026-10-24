"""Tests for the first-run helpers (app/routers/onboarding.py): the sample
report, loading and removing the demo data, and the status the empty-state
prompts and the "worker is not running" banner read.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import models
from app.config import get_settings
from app.db import get_db
from app.main import app
from app.services.text_reader import extract_text, read_identifiers
from tests.conftest import TestSessionLocal

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


@pytest.fixture(autouse=True)
def _scratch_storage(tmp_path, monkeypatch):
    """The demo seeds write their placeholder scans to the attachment folder."""
    monkeypatch.setattr(get_settings(), "attachment_storage_dir", str(tmp_path / "attachments"))


# ---------- sample report ----------


def test_sample_report_is_a_pdf_the_app_can_read_without_an_api_key(client):
    response = client.get("/onboarding/sample-report")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["cache-control"] == "no-store"
    assert "sample-service-report-WO-9" in response.headers["content-disposition"]
    read = read_identifiers(extract_text(response.content), ["LSRFortessa", "FACSAria III"])
    assert read.model == "LSRFortessa"
    assert read.serial == "R647794E6092"
    assert read.task_code == "T113"
    assert read.work_order_number and read.work_order_number.startswith("WO-9")


def test_every_sample_report_has_its_own_bytes_and_work_order(client):
    first = client.get("/onboarding/sample-report")
    second = client.get("/onboarding/sample-report")

    assert first.content != second.content
    assert first.headers["content-disposition"] != second.headers["content-disposition"]


def test_a_sample_report_goes_through_the_whole_intake_flow(client, run_worker):
    """Upload -> classify: matched to the LSRFortessa by serial, report type
    repair from the task code, and the same sample can be uploaded again."""
    for _ in range(2):
        sample = client.get("/onboarding/sample-report")
        report = client.post("/reports", json={}).json()
        attachment = client.post(
            f"/reports/{report['id']}/attachments", files={"file": ("sample.pdf", sample.content, "application/pdf")}
        ).json()
        assert client.post(f"/attachments/{attachment['id']}/classify").status_code == 202
        run_worker()

        report = client.get(f"/reports/{report['id']}").json()
        assert report["status"] == "classified"
        instrument = client.get(f"/instruments/{report['instrument_id']}").json()
        assert instrument["model"] == "LSRFortessa"


# ---------- status ----------


def test_status_of_a_fresh_install_has_instruments_and_nothing_else(client):
    status = client.get("/onboarding/status").json()

    assert status["instruments"] == 5
    assert status["reports"] == 0
    assert status["finalized_reports"] == 0
    assert status["demo_reports"] == 0
    assert status["pending_jobs"] == 0
    assert status["oldest_pending_seconds"] is None


def test_status_reports_how_long_the_oldest_job_has_waited(client):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    assert client.post(f"/attachments/{attachment['id']}/classify").status_code == 202
    with TestSessionLocal() as db:
        job = db.query(models.ExtractionJob).one()
        job.started_at = datetime.now(timezone.utc) - timedelta(seconds=45)
        db.commit()

    status = client.get("/onboarding/status").json()

    assert status["pending_jobs"] == 1
    assert 44 <= status["oldest_pending_seconds"] < 120


def test_status_has_no_wait_once_the_worker_has_taken_the_job(client, run_worker):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()

    status = client.get("/onboarding/status").json()

    assert status["pending_jobs"] == 0
    assert status["oldest_pending_seconds"] is None


# ---------- demo data ----------


def test_loading_the_demo_data_adds_the_demo_reports_once(client):
    first = client.post("/onboarding/demo-data")
    second = client.post("/onboarding/demo-data")

    assert first.status_code == 200
    assert first.json() == {"reports_added": 8, "reports_removed": 0, "demo_reports": 8}
    assert second.json() == {"reports_added": 0, "reports_removed": 0, "demo_reports": 8}
    status = client.get("/onboarding/status").json()
    assert status["reports"] == 8
    assert status["finalized_reports"] == 8
    assert status["demo_reports"] == 8
    listed = client.get("/reports").json()
    assert {r["status"] for r in listed} == {"finalized"}


def test_demo_data_fills_the_trend_chart(client):
    client.post("/onboarding/demo-data")
    aria = next(i for i in client.get("/instruments").json() if i["model"] == "FACSAria III")

    fields = client.get(f"/instruments/{aria['id']}/trend-fields").json()

    assert fields  # the calibration series has numeric fields to chart


def test_demo_data_needs_the_demo_instruments(client):
    with TestSessionLocal() as db:
        db.query(models.Instrument).delete()
        db.commit()

    response = client.post("/onboarding/demo-data")

    assert response.status_code == 409
    assert "Instruments tab" in response.json()["detail"]


def test_removing_the_demo_data_leaves_real_reports_alone(client):
    client.post("/onboarding/demo-data")
    real = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    # Named like a demo report, but its scan is a person's own upload.
    lookalike = client.post("/reports", json={"technician_name": "Demo - my own upload"}).json()
    client.post(f"/reports/{lookalike['id']}/attachments", files={"file": PDF})

    removed = client.delete("/onboarding/demo-data")

    assert removed.status_code == 200
    assert removed.json() == {"reports_added": 0, "reports_removed": 8, "demo_reports": 0}
    remaining = {r["id"] for r in client.get("/reports").json()}
    assert remaining == {real["id"], lookalike["id"]}
    assert client.get("/onboarding/status").json()["demo_reports"] == 0


def test_removing_the_demo_data_also_removes_reports_made_from_the_sample_report(client):
    sample = client.get("/onboarding/sample-report")
    report = client.post("/reports", json={"technician_name": "Demo - sample report"}).json()
    client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("sample-service-report.pdf", sample.content, "application/pdf")},
    )
    assert client.get("/onboarding/status").json()["demo_reports"] == 1

    removed = client.delete("/onboarding/demo-data")

    assert removed.json()["reports_removed"] == 1
    assert client.get(f"/reports/{report['id']}").status_code == 404


def test_removing_demo_data_when_there_is_none_is_fine(client):
    response = client.delete("/onboarding/demo-data")

    assert response.status_code == 200
    assert response.json()["reports_removed"] == 0


def test_removing_the_demo_data_waits_for_a_job_in_flight(client):
    client.post("/onboarding/demo-data")
    with TestSessionLocal() as db:
        attachment = db.query(models.Attachment).first()
        db.add(
            models.ExtractionJob(
                attachment_id=attachment.id,
                kind=models.ExtractionJobKind.classify,
                status=models.ExtractionJobStatus.pending,
                started_at=datetime.now(timezone.utc),
            )
        )
        db.commit()

    response = client.delete("/onboarding/demo-data")

    assert response.status_code == 409
    assert client.get("/onboarding/status").json()["demo_reports"] == 8


def test_removing_the_demo_data_after_losing_a_race_is_a_409(client):
    """A job queued between the check and the delete trips the foreign key."""
    client.post("/onboarding/demo-data")
    state = {"armed": True}

    def _override_get_db():
        db = TestSessionLocal()
        real_commit = db.commit

        def commit():
            if state["armed"]:
                state["armed"] = False
                with TestSessionLocal() as other:
                    attachment = other.query(models.Attachment).first()
                    other.add(
                        models.ExtractionJob(
                            attachment_id=attachment.id,
                            kind=models.ExtractionJobKind.classify,
                            status=models.ExtractionJobStatus.succeeded,
                            started_at=datetime.now(timezone.utc),
                        )
                    )
                    other.commit()
            real_commit()

        db.commit = commit
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db

    response = client.delete("/onboarding/demo-data")

    assert response.status_code == 409
    assert "changed" in response.json()["detail"]
