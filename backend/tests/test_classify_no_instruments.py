"""Classifying when no instrument is registered (easy to reach now that an
instrument can be deleted) must fail the job with a clear message, not crash
the worker with "Worker crashed processing this job"."""
from __future__ import annotations

import pytest

from app import models
from app.services.classification import classify
from app.services.errors import ClassificationError
from tests.conftest import TestSessionLocal


def _delete_every_instrument(client):
    for instrument in client.get("/instruments").json():
        assert client.delete(f"/instruments/{instrument['id']}").status_code == 204
    assert client.get("/instruments").json() == []


def test_classify_with_no_instruments_raises_a_classification_error(client):
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")}
    ).json()
    _delete_every_instrument(client)

    with TestSessionLocal() as db:
        row = db.get(models.Attachment, attachment["id"])
        with pytest.raises(ClassificationError, match="Instruments tab"):
            classify(db, row)


def test_the_job_fails_with_the_clear_message_and_the_report_is_left_alone(client, run_worker):
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4 y", "application/pdf")}
    ).json()
    _delete_every_instrument(client)

    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    assert run_worker() == 1

    done = client.get(f"/extraction-jobs/{job['id']}").json()
    assert done["status"] == "failed"
    assert "No instruments registered" in done["error_message"]
    assert "Instruments tab" in done["error_message"]
    assert "crashed" not in done["error_message"].lower()
    after = client.get(f"/reports/{report['id']}").json()
    assert after["status"] == "draft" and after["instrument_id"] is None and after["template_id"] is None


def test_classifying_works_again_once_an_instrument_is_added(client, run_worker):
    _delete_every_instrument(client)
    client.post("/instruments", json={"name": "New", "model": "LSRFortessa", "serial_number": "NEW-1"})
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4 z", "application/pdf")}
    ).json()

    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()

    assert client.get(f"/extraction-jobs/{job['id']}").json()["status"] == "succeeded"
