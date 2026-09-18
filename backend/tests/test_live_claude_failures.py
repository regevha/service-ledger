"""Tests for the failure handling added around the live Claude calls
(see app/services/errors.py).

These monkeypatch classify()/extract() rather than actually calling the
Claude API — conftest.py already forces USE_LIVE_CLAUDE=false for the whole
suite so tests never spend a real call or depend on a developer's .env. The
point here isn't to test Claude itself, it's to prove that when the live
call fails (network error, bad key, a malformed response — all wrapped as
ClassificationError/ExtractionError by the live path), the worker (§3)
records a failed ExtractionJob with a real error_message instead of letting
the exception take down the whole polling loop.

Since classify/extract only enqueue a job now (§9's submit-and-poll
contract) — the actual call happens in app.worker, not in the router — the
functions to patch moved from app.routers.attachments to app.worker, and
"did it fail" is now observed by draining the queue (run_worker) and reading
the job back, not by asserting on the submit response's status code (which
is always 202 the moment an attachment is found — see test_error_paths.py
for that 404 case).
"""
from __future__ import annotations

from app.services.errors import ClassificationError, ExtractionError


def test_classification_failure_records_failed_job(client, run_worker, monkeypatch):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("broken.pdf", b"%PDF-1.4 fake scan", "application/pdf")},
    )
    attachment = upload.json()

    def _boom(db, attachment):
        raise ClassificationError("Claude API request failed during classification: simulated outage")

    monkeypatch.setattr("app.worker.run_classify", _boom)

    submitted = client.post(f"/attachments/{attachment['id']}/classify")
    assert submitted.status_code == 202
    run_worker()

    job = client.get(f"/extraction-jobs/{submitted.json()['id']}").json()
    assert job["status"] == "failed"
    assert job["error_message"] is not None
    assert "simulated outage" in job["error_message"]
    assert job["completed_at"] is not None


def test_extraction_failure_records_failed_job(client, run_worker, monkeypatch):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("aria_pm_2026.pdf", b"%PDF-1.4 fake pm scan", "application/pdf")},
    )
    attachment = upload.json()

    submitted = client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    classification = client.get(f"/extraction-jobs/{submitted.json()['id']}").json()["classification"]
    assert classification["resolved_template_id"] is not None  # confident stub guess, per classification.py

    def _boom(attachment, template):
        raise ExtractionError("Claude API request failed during extraction: simulated timeout")

    monkeypatch.setattr("app.worker.run_extract", _boom)

    extraction = client.post(f"/attachments/{attachment['id']}/extract")
    assert extraction.status_code == 202
    run_worker()

    job = client.get(f"/extraction-jobs/{extraction.json()['id']}").json()
    assert job["status"] == "failed"
    assert job["error_message"] is not None
    assert "simulated timeout" in job["error_message"]
