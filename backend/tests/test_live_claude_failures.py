"""Tests for the failure handling added around the live Claude calls
(see app/services/errors.py).

These monkeypatch classify()/extract() rather than actually calling the
Claude API — conftest.py already forces USE_LIVE_CLAUDE=false for the whole
suite so tests never spend a real call or depend on a developer's .env. The
point here isn't to test Claude itself, it's to prove that when the live
call fails (network error, bad key, a malformed response — all wrapped as
ClassificationError/ExtractionError by the live path), the router records a
failed ExtractionJob with a real error_message instead of letting the
exception 500 out with no trace of what was attempted.
"""
from __future__ import annotations

import uuid

from app import models
from app.services.errors import ClassificationError, ExtractionError


def test_classification_failure_records_failed_job_and_returns_502(client, seeded, monkeypatch):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("broken.pdf", b"%PDF-1.4 fake scan", "application/pdf")},
    )
    attachment = upload.json()

    def _boom(db, attachment):
        raise ClassificationError("Claude API request failed during classification: simulated outage")

    monkeypatch.setattr("app.routers.attachments.run_classify", _boom)

    resp = client.post(f"/attachments/{attachment['id']}/classify")
    assert resp.status_code == 502
    assert "simulated outage" in resp.json()["detail"]

    job = (
        seeded.query(models.ExtractionJob)
        .filter_by(attachment_id=uuid.UUID(attachment["id"]))
        .one()
    )
    assert job.status == models.ExtractionJobStatus.failed
    assert job.error_message is not None
    assert "simulated outage" in job.error_message
    assert job.completed_at is not None


def test_extraction_failure_records_failed_job_and_returns_502(client, seeded, monkeypatch):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("aria_pm_2026.pdf", b"%PDF-1.4 fake pm scan", "application/pdf")},
    )
    attachment = upload.json()

    classification = client.post(f"/attachments/{attachment['id']}/classify").json()
    assert classification["resolved_template_id"] is not None  # confident stub guess, per classification.py

    def _boom(attachment, template):
        raise ExtractionError("Claude API request failed during extraction: simulated timeout")

    monkeypatch.setattr("app.routers.attachments.run_extract", _boom)

    resp = client.post(f"/attachments/{attachment['id']}/extract")
    assert resp.status_code == 502
    assert "simulated timeout" in resp.json()["detail"]

    job = (
        seeded.query(models.ExtractionJob)
        .filter_by(attachment_id=uuid.UUID(attachment["id"]))
        .order_by(models.ExtractionJob.started_at.desc())
        .first()
    )
    assert job is not None
    assert job.status == models.ExtractionJobStatus.failed
    assert job.error_message is not None
    assert "simulated timeout" in job.error_message
