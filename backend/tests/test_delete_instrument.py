"""DELETE /instruments/{id} removes the instrument together with every report
on it (drafts and finalized, whatever the instrument's status), their
attachments, extraction jobs and stored scan files. A report whose scan is
still being read makes it a 409.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from sqlalchemy import text

from app.schemas import ClassificationGuess
from tests.conftest import TestSessionLocal


def _confident(monkeypatch):
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: (
            ClassificationGuess(value="LSRFortessa", confidence=0.99),
            ClassificationGuess(value="repair", confidence=0.99),
            None,
        ),
    )


def _new_instrument(client, serial="DEL-1", model="LSRFortessa"):
    return client.post("/instruments", json={"name": serial, "model": model, "serial_number": serial}).json()


def _report_on(client, instrument_id, *, upload=True):
    """A draft report confirmed onto `instrument_id`, with a scan attached."""
    report = client.post("/reports", json={}).json()
    template = client.get("/report-templates", params={"report_type": "repair", "model": "LSRFortessa"}).json()[0]
    assert client.patch(
        f"/reports/{report['id']}/template", json={"instrument_id": instrument_id, "template_id": template["id"]}
    ).status_code == 200
    attachment = None
    if upload:
        data = f"%PDF-1.4 {uuid.uuid4()}".encode()
        attachment = client.post(
            f"/reports/{report['id']}/attachments", files={"file": ("scan.pdf", data, "application/pdf")}
        ).json()
    return report, attachment


def _count(table: str) -> int:
    with TestSessionLocal() as db:
        return db.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()


def _scan_path(client, report_id) -> Path:
    return Path(client.get(f"/reports/{report_id}").json()["attachments"][0]["file_path"])


def test_deleting_an_instrument_with_no_reports_removes_it(client):
    inst = _new_instrument(client)

    assert client.delete(f"/instruments/{inst['id']}").status_code == 204

    assert client.get(f"/instruments/{inst['id']}").status_code == 404
    assert inst["id"] not in [i["id"] for i in client.get("/instruments").json()]


def test_deleting_an_unknown_instrument_is_404(client):
    assert client.delete(f"/instruments/{uuid.uuid4()}").status_code == 404


@pytest.mark.parametrize("status", ["active", "maintenance", "retired"])
def test_deleting_an_instrument_deletes_all_its_reports_whatever_its_status(client, status):
    inst = _new_instrument(client)
    assert client.patch(f"/instruments/{inst['id']}", json={"status": status}).status_code == 200
    reports = [_report_on(client, inst["id"])[0] for _ in range(2)]
    paths = [_scan_path(client, r["id"]) for r in reports]
    assert all(p.exists() for p in paths)

    assert client.delete(f"/instruments/{inst['id']}").status_code == 204

    assert client.get(f"/instruments/{inst['id']}").status_code == 404
    for report, path in zip(reports, paths):
        assert client.get(f"/reports/{report['id']}").status_code == 404
        assert not path.exists() and not path.parent.exists()
    assert _count("reports") == 0 and _count("attachments") == 0


def test_finalized_reports_are_deleted_too_and_their_jobs_with_them(client, run_worker, monkeypatch):
    _confident(monkeypatch)
    inst = _new_instrument(client)
    report, attachment = _report_on(client, inst["id"])
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    assert client.post(f"/reports/{report['id']}/finalize").status_code == 200
    assert _count("extraction_jobs") == 1

    assert client.delete(f"/instruments/{inst['id']}").status_code == 204

    assert client.get(f"/reports/{report['id']}").status_code == 404
    assert _count("reports") == 0 and _count("attachments") == 0 and _count("extraction_jobs") == 0
    assert client.get(f"/attachments/{attachment['id']}/file").status_code == 404


def test_reports_of_other_instruments_and_other_units_of_the_model_are_untouched(client):
    doomed = _new_instrument(client, "DEL-A")
    sibling = _new_instrument(client, "DEL-B")  # same model
    _report_on(client, doomed["id"])
    keep, keep_attachment = _report_on(client, sibling["id"])
    unattached = client.post("/reports", json={"technician_name": "no instrument"}).json()

    assert client.delete(f"/instruments/{doomed['id']}").status_code == 204

    assert client.get(f"/reports/{keep['id']}").json()["instrument_id"] == sibling["id"]
    assert client.get(f"/attachments/{keep_attachment['id']}/file").status_code == 200
    assert client.get(f"/reports/{unattached['id']}").status_code == 200
    assert client.get(f"/instruments/{sibling['id']}").status_code == 200
    assert _count("reports") == 2


def test_an_instrument_with_a_scan_still_being_read_is_refused_and_nothing_is_deleted(client):
    inst = _new_instrument(client)
    report, attachment = _report_on(client, inst["id"])
    assert client.post(f"/attachments/{attachment['id']}/classify").status_code == 202  # job left pending

    resp = client.delete(f"/instruments/{inst['id']}")

    assert resp.status_code == 409
    assert "still being read" in resp.json()["detail"]
    assert client.get(f"/instruments/{inst['id']}").status_code == 200
    assert client.get(f"/reports/{report['id']}").status_code == 200
    assert _scan_path(client, report["id"]).exists()


def test_a_finished_job_does_not_block_the_delete(client, run_worker, monkeypatch):
    _confident(monkeypatch)
    inst = _new_instrument(client)
    _, attachment = _report_on(client, inst["id"])
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()

    assert client.delete(f"/instruments/{inst['id']}").status_code == 204


def test_a_missing_scan_file_does_not_stop_the_delete(client):
    inst = _new_instrument(client)
    report, _ = _report_on(client, inst["id"])
    _scan_path(client, report["id"]).unlink()

    assert client.delete(f"/instruments/{inst['id']}").status_code == 204
    assert _count("reports") == 0
