"""Tests for DELETE /reports/{id}: removes the report, its attachments, their
extraction jobs and the stored scan files; a finalized report needs
`?force=true`; a report whose scan is still being read is refused.
"""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlalchemy import text

from app import models
from app.schemas import ClassificationGuess
from tests.conftest import TestSessionLocal

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


def _confident(monkeypatch):
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: (
            ClassificationGuess(value="LSRFortessa", confidence=0.99),
            ClassificationGuess(value="repair", confidence=0.99),
            None,
        ),
    )


def _extracted_report(client, run_worker, monkeypatch):
    _confident(monkeypatch)
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    report = client.get(f"/reports/{report['id']}").json()
    assert report["status"] == "extracted"
    return report, attachment


def _count(table: str) -> int:
    with TestSessionLocal() as db:
        return db.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()


def test_deleting_a_draft_report_removes_it(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    response = client.delete(f"/reports/{report['id']}")

    assert response.status_code == 204
    assert client.get(f"/reports/{report['id']}").status_code == 404
    assert report["id"] not in [r["id"] for r in client.get("/reports").json()]


def test_deleting_an_unknown_report_returns_404(client):
    assert client.delete(f"/reports/{uuid.uuid4()}").status_code == 404


def test_deleting_removes_attachments_jobs_and_scan_files(client, run_worker, monkeypatch):
    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    stored = client.get(f"/reports/{report['id']}").json()["attachments"][0]["file_path"]
    assert Path(stored).exists()
    assert _count("extraction_jobs") == 2

    assert client.delete(f"/reports/{report['id']}").status_code == 204

    assert _count("reports") == 0
    assert _count("attachments") == 0
    assert _count("extraction_jobs") == 0
    assert not Path(stored).exists()
    assert not Path(stored).parent.exists()
    assert client.get(f"/attachments/{attachment['id']}/file").status_code == 404


def test_deleting_one_report_leaves_other_reports_and_their_files_alone(client):
    keep = client.post("/reports", json={"technician_name": "keep"}).json()
    drop = client.post("/reports", json={"technician_name": "drop"}).json()
    kept_attachment = client.post(f"/reports/{keep['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/reports/{drop['id']}/attachments", files={"file": ("other.pdf", b"%PDF-1.4 y", "application/pdf")})

    assert client.delete(f"/reports/{drop['id']}").status_code == 204

    assert client.get(f"/reports/{keep['id']}").status_code == 200
    assert client.get(f"/attachments/{kept_attachment['id']}/file").status_code == 200


def test_deleting_a_report_does_not_touch_its_instrument(client, run_worker, monkeypatch):
    report, _ = _extracted_report(client, run_worker, monkeypatch)
    instrument_id = report["instrument_id"]

    assert client.delete(f"/reports/{report['id']}").status_code == 204

    assert instrument_id in [i["id"] for i in client.get("/instruments").json()]
    assert client.get("/reports", params={"instrument_id": instrument_id}).json() == []


def test_a_finalized_report_needs_force(client, run_worker, monkeypatch):
    report, _ = _extracted_report(client, run_worker, monkeypatch)
    assert client.post(f"/reports/{report['id']}/finalize").status_code == 200

    refused = client.delete(f"/reports/{report['id']}")
    assert refused.status_code == 409
    assert "finalized" in refused.json()["detail"]
    assert client.get(f"/reports/{report['id']}").status_code == 200

    assert client.delete(f"/reports/{report['id']}", params={"force": "true"}).status_code == 204
    assert client.get(f"/reports/{report['id']}").status_code == 404


def test_a_report_whose_scan_is_still_being_read_is_refused(client):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    assert client.post(f"/attachments/{attachment['id']}/classify").status_code == 202  # job left pending

    response = client.delete(f"/reports/{report['id']}")

    assert response.status_code == 409
    assert "still being read" in response.json()["detail"]
    assert client.get(f"/reports/{report['id']}").status_code == 200


def test_a_failed_job_does_not_block_deletion(client):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    with TestSessionLocal() as db:
        row = db.get(models.ExtractionJob, uuid.UUID(job["id"]))
        row.status = models.ExtractionJobStatus.failed
        db.commit()

    assert client.delete(f"/reports/{report['id']}").status_code == 204
    assert _count("extraction_jobs") == 0


def test_deleting_still_succeeds_when_the_scan_file_is_already_gone(client):
    report = client.post("/reports", json={}).json()
    client.post(f"/reports/{report['id']}/attachments", files={"file": PDF})
    stored = client.get(f"/reports/{report['id']}").json()["attachments"][0]["file_path"]
    Path(stored).unlink()

    assert client.delete(f"/reports/{report['id']}").status_code == 204
    assert _count("attachments") == 0


def test_deleting_one_copy_of_a_report_loaded_twice_leaves_the_other(client):
    """The same file uploaded twice makes two separate reports (duplicate
    detection only warns), each with its own attachment row and folder on
    disk, so deleting one must not touch the other."""
    first = client.post("/reports", json={"technician_name": "first"}).json()
    second = client.post("/reports", json={"technician_name": "second"}).json()
    client.post(f"/reports/{first['id']}/attachments", files={"file": PDF})
    dup = client.post(f"/reports/{second['id']}/attachments", files={"file": PDF}).json()
    assert dup["duplicate_report_ids"] == [first["id"]]

    assert client.delete(f"/reports/{first['id']}").status_code == 204

    assert client.get(f"/reports/{first['id']}").status_code == 404
    assert client.get(f"/reports/{second['id']}").status_code == 200
    assert client.get(f"/attachments/{dup['id']}/file").status_code == 200
    assert _count("reports") == 1
    assert _count("attachments") == 1
