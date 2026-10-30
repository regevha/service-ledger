"""Asking again while a job runs returns that job; uploads stop reading at the size limit."""
from app.config import get_settings


def _upload(client, name="scan.pdf", body=b"%PDF-1.4 fake scan"):
    report = client.post("/reports", json={}).json()
    att = client.post(f"/reports/{report['id']}/attachments", files={"file": (name, body, "application/pdf")})
    assert att.status_code == 201, att.text
    return att.json()["id"]


def test_classify_twice_while_pending_returns_the_same_job(client):
    att = _upload(client)
    first = client.post(f"/attachments/{att}/classify")
    second = client.post(f"/attachments/{att}/classify")
    assert first.status_code == second.status_code == 202
    assert first.json()["id"] == second.json()["id"]


def test_after_the_job_finishes_asking_again_queues_a_new_one(client, run_worker):
    att = _upload(client)
    first = client.post(f"/attachments/{att}/classify").json()
    run_worker()
    assert client.get(f"/extraction-jobs/{first['id']}").json()["status"] in ("succeeded", "failed")
    assert client.post(f"/attachments/{att}/classify").json()["id"] != first["id"]


def test_a_cancelled_job_does_not_block_a_new_one(client):
    att = _upload(client)
    first = client.post(f"/attachments/{att}/classify").json()
    assert client.post(f"/extraction-jobs/{first['id']}/cancel").status_code == 200
    assert client.post(f"/attachments/{att}/classify").json()["id"] != first["id"]


def test_a_different_kind_is_not_blocked_by_a_running_one(client):
    att = _upload(client)
    classify = client.post(f"/attachments/{att}/classify").json()
    translate = client.post(f"/attachments/{att}/translate").json()
    assert classify["id"] != translate["id"] and translate["kind"] == "translate"


def test_an_upload_over_the_limit_is_refused_without_storing_it(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_pdf_upload_bytes", 3 * 1024 * 1024)
    report = client.post("/reports", json={}).json()
    big = b"%PDF-1.4 " + b"x" * (3 * 1024 * 1024 + 10)
    resp = client.post(f"/reports/{report['id']}/attachments", files={"file": ("big.pdf", big, "application/pdf")})
    assert resp.status_code == 413
    assert "the limit is 3 MB" in resp.json()["detail"]
    assert client.get(f"/reports/{report['id']}").json()["attachments"] == []


def test_an_upload_just_under_the_limit_is_accepted(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_pdf_upload_bytes", 3 * 1024 * 1024)
    report = client.post("/reports", json={}).json()
    body = b"%PDF-1.4 " + b"x" * (3 * 1024 * 1024 - 20)
    resp = client.post(f"/reports/{report['id']}/attachments", files={"file": ("ok.pdf", body, "application/pdf")})
    assert resp.status_code == 201
