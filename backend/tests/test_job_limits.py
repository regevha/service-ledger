"""Daily job cap and the per-document failed-attempt limit (HTTP 429)."""
from datetime import datetime, timedelta, timezone

from app import models
from app.config import get_settings


def _upload(client, name="scan.pdf"):
    report = client.post("/reports", json={}).json()
    att = client.post(f"/reports/{report['id']}/attachments", files={"file": (name, b"%PDF-1.4 fake", "application/pdf")})
    assert att.status_code == 201, att.text
    return att.json()["id"]


def _add_jobs(db_session, att, n, *, status, kind=models.ExtractionJobKind.classify, age=timedelta(0), error=None):
    import uuid

    for _ in range(n):
        db_session.add(
            models.ExtractionJob(
                attachment_id=uuid.UUID(att),
                kind=kind,
                status=status,
                error_message=error,
                started_at=datetime.now(timezone.utc) - age,
            )
        )
    db_session.commit()


def test_daily_cap_blocks_new_jobs_of_every_kind(client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "daily_job_cap", 5)
    att = _upload(client)
    other = _upload(client, "other.pdf")
    _add_jobs(db_session, other, 5, status=models.ExtractionJobStatus.succeeded)
    for path in ("classify", "translate"):
        resp = client.post(f"/attachments/{att}/{path}")
        assert resp.status_code == 429, path
        assert "daily limit of 5" in resp.json()["detail"]


def test_jobs_older_than_a_day_do_not_count(client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "daily_job_cap", 5)
    att = _upload(client)
    _add_jobs(db_session, att, 5, status=models.ExtractionJobStatus.succeeded, age=timedelta(hours=25))
    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_jobs_cancelled_unsent_do_not_count(client, db_session, monkeypatch):
    from app.services.job_limits import CANCELLED_UNSENT

    monkeypatch.setattr(get_settings(), "daily_job_cap", 5)
    att = _upload(client)
    _add_jobs(db_session, att, 5, status=models.ExtractionJobStatus.failed, error=CANCELLED_UNSENT)
    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_cap_of_zero_turns_the_limit_off(client, db_session, monkeypatch):
    monkeypatch.setattr(get_settings(), "daily_job_cap", 0)
    att = _upload(client)
    _add_jobs(db_session, att, 80, status=models.ExtractionJobStatus.succeeded)
    assert client.post(f"/attachments/{att}/classify").status_code == 202


def test_third_failure_blocks_the_fourth_attempt(client, db_session):
    att = _upload(client)
    _add_jobs(db_session, att, 2, status=models.ExtractionJobStatus.failed, error="unreadable")
    assert client.post(f"/attachments/{att}/classify").status_code == 202  # third attempt still allowed
    db_session.query(models.ExtractionJob).filter_by(status=models.ExtractionJobStatus.pending).delete()
    db_session.commit()
    _add_jobs(db_session, att, 1, status=models.ExtractionJobStatus.failed, error="unreadable")
    resp = client.post(f"/attachments/{att}/classify")
    assert resp.status_code == 429
    assert "failed 3 times" in resp.json()["detail"]


def test_failures_are_counted_per_kind_and_per_document(client, db_session):
    att = _upload(client)
    other = _upload(client, "other.pdf")
    _add_jobs(db_session, att, 3, status=models.ExtractionJobStatus.failed, error="unreadable")
    assert client.post(f"/attachments/{att}/classify").status_code == 429
    assert client.post(f"/attachments/{att}/translate").status_code == 202
    assert client.post(f"/attachments/{other}/classify").status_code == 202


def test_returning_the_running_job_is_not_limited(client, db_session, monkeypatch):
    att = _upload(client)
    first = client.post(f"/attachments/{att}/classify").json()
    monkeypatch.setattr(get_settings(), "daily_job_cap", 1)
    again = client.post(f"/attachments/{att}/classify")
    assert again.status_code == 202 and again.json()["id"] == first["id"]
