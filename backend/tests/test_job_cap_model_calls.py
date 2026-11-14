"""The daily cap counts model jobs: a translate job that is decided from the text layer, without the
model, is marked `model_called: false` by the worker and then stops counting (SL-74)."""
from __future__ import annotations

import uuid

from app import models, worker
from app.config import get_settings


def _upload_and_translate(client, run_worker, monkeypatch, *, layer_share, live=True, include_pages=None):
    monkeypatch.setattr(get_settings(), "use_live_claude", live)
    monkeypatch.setattr(worker, "text_layer_hebrew_share", lambda attachment: layer_share)
    monkeypatch.setattr(worker, "run_translate", lambda attachment, pages: None)  # "not Hebrew"
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    att = client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4 fake", "application/pdf")}
    ).json()["id"]
    body = {"include_pages": include_pages} if include_pages else None
    job_id = client.post(f"/attachments/{att}/translate", json=body).json()["id"]
    run_worker()
    return att, job_id


def _params(db_session, job_id):
    db_session.expire_all()
    return db_session.get(models.ExtractionJob, uuid.UUID(job_id)).params


def test_a_readable_non_hebrew_text_layer_job_is_marked_as_not_calling_the_model(client, db_session, run_worker, monkeypatch):
    _att, job_id = _upload_and_translate(client, run_worker, monkeypatch, layer_share=0.0)
    assert (_params(db_session, job_id) or {}).get("model_called") is False


def test_a_scan_without_a_text_layer_is_not_marked(client, db_session, run_worker, monkeypatch):
    # No text layer: the small language check is a model call, so the job counts.
    _att, job_id = _upload_and_translate(client, run_worker, monkeypatch, layer_share=None)
    assert "model_called" not in (_params(db_session, job_id) or {})


def test_a_hebrew_text_layer_is_not_marked(client, db_session, run_worker, monkeypatch):
    _att, job_id = _upload_and_translate(client, run_worker, monkeypatch, layer_share=0.9)
    assert "model_called" not in (_params(db_session, job_id) or {})


def test_explicit_pages_are_not_marked(client, db_session, run_worker, monkeypatch):
    _att, job_id = _upload_and_translate(client, run_worker, monkeypatch, layer_share=0.0, include_pages=[1])
    assert "model_called" not in (_params(db_session, job_id) or {})


def test_stub_mode_is_not_marked(client, db_session, run_worker, monkeypatch):
    _att, job_id = _upload_and_translate(client, run_worker, monkeypatch, layer_share=0.0, live=False)
    assert "model_called" not in (_params(db_session, job_id) or {})


def test_free_translate_jobs_leave_room_under_the_cap(client, run_worker, monkeypatch):
    """With a cap of 25, 21 free translate jobs (text-layer files) leave room for 21 classify jobs.
    Before SL-74 the 21 translate jobs alone used 21 of the 25 and the 5th classify was refused."""
    monkeypatch.setattr(get_settings(), "daily_job_cap", 25)
    monkeypatch.setattr(get_settings(), "use_live_claude", True)
    monkeypatch.setattr(worker, "text_layer_hebrew_share", lambda attachment: 0.0)
    monkeypatch.setattr(worker, "run_translate", lambda attachment, pages: None)
    ids = []
    for i in range(21):
        report = client.post("/reports", json={}).json()
        up = client.post(
            f"/reports/{report['id']}/attachments",
            files={"file": (f"{i}.pdf", b"%PDF-1.4 fake" + bytes([i]), "application/pdf")},
        )
        assert up.status_code == 201, up.text
        ids.append(up.json()["id"])
    for att in ids:
        assert client.post(f"/attachments/{att}/translate").status_code == 202
        run_worker()
    for att in ids:
        assert client.post(f"/attachments/{att}/classify").status_code == 202
