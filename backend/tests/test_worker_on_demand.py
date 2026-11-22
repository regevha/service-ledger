"""The on-demand worker: `python -m app.worker --once` (worker.run_once), the run lock that
keeps one run on the queue at a time, and the trigger the routers call after queueing a job
(app/job_trigger.py)."""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import text

from app import job_trigger, models
from app.config import get_settings
from app.db import engine
from app.job_queue import _RUN_LOCK_KEY, run_lock
from app.worker import run_once
from tests.conftest import TestSessionLocal


@pytest.fixture()
def fast_settings(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "worker_idle_exit_seconds", 0.3)
    monkeypatch.setattr(s, "worker_poll_interval_seconds", 0.05)
    monkeypatch.setattr(s, "worker_run_lock_wait_seconds", 0.3)
    return s


@pytest.fixture(autouse=True)
def reset_trigger_state(monkeypatch):
    monkeypatch.setattr(job_trigger, "_last_fired", None)
    monkeypatch.setattr(job_trigger, "_children", [])


def _pending_classify_job(db) -> models.ExtractionJob:
    report = models.Report()
    db.add(report)
    db.flush()
    attachment = models.Attachment(report_id=report.id, file_path="scan.pdf", file_type="application/pdf", page_count=1)
    db.add(attachment)
    db.flush()
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    return job


# ---- run_once -------------------------------------------------------------------------


def test_run_once_returns_zero_and_exits_when_the_queue_is_empty(seeded, fast_settings):
    started = time.monotonic()
    assert run_once() == 0
    assert time.monotonic() - started < 5


def test_run_once_drains_every_pending_job_then_exits(seeded, fast_settings):
    jobs = [_pending_classify_job(seeded) for _ in range(3)]
    assert run_once() == 3
    seeded.expire_all()
    for job in jobs:
        seeded.refresh(job)
        assert job.status != models.ExtractionJobStatus.pending


def test_run_once_picks_up_a_job_queued_while_it_idles(seeded, fast_settings, monkeypatch):
    monkeypatch.setattr(fast_settings, "worker_idle_exit_seconds", 1.5)
    late = {}

    def queue_late():
        time.sleep(0.4)
        with TestSessionLocal() as db:
            late["job_id"] = _pending_classify_job(db).id

    t = threading.Thread(target=queue_late)
    t.start()
    assert run_once() == 1
    t.join()
    seeded.expire_all()
    assert seeded.get(models.ExtractionJob, late["job_id"]).status != models.ExtractionJobStatus.pending


def test_run_once_stops_claiming_after_its_time_limit(seeded, fast_settings, monkeypatch):
    import app.worker as worker_module

    monkeypatch.setattr(fast_settings, "worker_max_run_seconds", 0.2)
    first, second = _pending_classify_job(seeded), _pending_classify_job(seeded)
    real_tick = worker_module._worker_tick

    def slow_tick():
        result = real_tick()
        time.sleep(0.3)  # the first job "takes" longer than the run's limit
        return result

    monkeypatch.setattr(worker_module, "_worker_tick", slow_tick)
    assert run_once() == 1  # the limit is reached after one job: the other waits for the next run
    seeded.expire_all()
    seeded.refresh(first)
    seeded.refresh(second)
    assert sorted([first.status.value, second.status.value]) == ["pending", "succeeded"]


def test_run_once_prunes_once_and_looks_at_the_queue_again_before_leaving(seeded, fast_settings, monkeypatch):
    import app.worker as worker_module

    late = {}

    def prune_while_a_job_arrives():
        with TestSessionLocal() as db:
            late["id"] = _pending_classify_job(db).id

    monkeypatch.setattr(worker_module, "_periodic_retention", prune_while_a_job_arrives)
    assert run_once() == 1  # the job queued during the prune is still picked up
    seeded.expire_all()
    assert seeded.get(models.ExtractionJob, late["id"]).status != models.ExtractionJobStatus.pending


def test_idle_exit_must_cover_the_trigger_merge_window(monkeypatch):
    from app.config import Settings

    with pytest.raises(ValueError, match="WORKER_IDLE_EXIT_SECONDS"):
        Settings(worker_idle_exit_seconds=1.0, worker_trigger_min_interval_seconds=3.0)


def test_run_once_exits_without_working_when_another_run_holds_the_lock(seeded, fast_settings):
    job = _pending_classify_job(seeded)
    with run_lock(0) as got:
        assert got is True
        assert run_once() == 0  # waits worker_run_lock_wait_seconds, then leaves the queue to the holder
    seeded.expire_all()
    seeded.refresh(job)
    assert job.status == models.ExtractionJobStatus.pending


def test_run_lock_is_released_when_the_run_ends(seeded):
    with run_lock(0) as first:
        assert first is True
    with run_lock(0) as second:
        assert second is True


def test_run_lock_waits_for_the_holder_to_let_go(seeded):
    holder_ready, release = threading.Event(), threading.Event()

    def hold():
        with run_lock(0):
            holder_ready.set()
            release.wait(5)

    t = threading.Thread(target=hold)
    t.start()
    holder_ready.wait(5)
    threading.Timer(0.5, release.set).start()
    with run_lock(3) as got:
        assert got is True
    t.join()


def test_a_dead_runs_lock_is_freed_with_its_connection(seeded):
    conn = engine.connect()
    assert conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _RUN_LOCK_KEY}).scalar() is True
    conn.commit()
    with run_lock(0) as while_held:
        assert while_held is False
    conn.invalidate()  # what a crashed process looks like to Postgres: the session just ends
    conn.close()
    with run_lock(0) as after:
        assert after is True


# ---- the trigger ----------------------------------------------------------------------


def test_trigger_does_nothing_by_default(monkeypatch):
    calls = []
    monkeypatch.setattr(job_trigger, "_fire", lambda mode: calls.append(mode))
    assert get_settings().worker_trigger == "none"
    job_trigger.notify_job_queued()
    assert calls == []


def test_trigger_fires_once_and_merges_a_burst(monkeypatch):
    calls = []
    s = get_settings()
    monkeypatch.setattr(s, "worker_trigger", "local")
    monkeypatch.setattr(s, "worker_trigger_min_interval_seconds", 60.0)
    monkeypatch.setattr(job_trigger, "_executor", _InlineExecutor())
    monkeypatch.setattr(job_trigger, "_fire", lambda mode: calls.append(mode))
    job_trigger.notify_job_queued()
    job_trigger.notify_job_queued()
    job_trigger.notify_job_queued()
    assert calls == ["local"]


def test_trigger_fires_again_after_the_interval(monkeypatch):
    calls = []
    s = get_settings()
    monkeypatch.setattr(s, "worker_trigger", "local")
    monkeypatch.setattr(s, "worker_trigger_min_interval_seconds", 0.0)
    monkeypatch.setattr(job_trigger, "_executor", _InlineExecutor())
    monkeypatch.setattr(job_trigger, "_fire", lambda mode: calls.append(mode))
    job_trigger.notify_job_queued()
    job_trigger.notify_job_queued()
    assert calls == ["local", "local"]


def test_a_failing_trigger_is_logged_not_raised(monkeypatch, caplog):
    def boom():
        raise RuntimeError("no network")

    monkeypatch.setattr(job_trigger, "_start_azure_job", boom)
    with caplog.at_level("ERROR", logger="app.worker"):
        job_trigger._fire("azure_job")
    assert "Could not start a worker run" in caplog.text


def test_a_broken_executor_never_fails_the_request(monkeypatch):
    class Dead:
        def submit(self, *a, **k):
            raise RuntimeError("shut down")

    monkeypatch.setattr(get_settings(), "worker_trigger", "local")
    monkeypatch.setattr(job_trigger, "_executor", Dead())
    job_trigger.notify_job_queued()  # must not raise


def test_local_trigger_starts_a_once_run(monkeypatch):
    started = []

    class FakeChild:
        pid = 4242

        def poll(self):
            return None

    def fake_popen(cmd, **kwargs):
        started.append((cmd, kwargs))
        return FakeChild()

    monkeypatch.setattr(job_trigger.subprocess, "Popen", fake_popen)
    job_trigger._start_local_run()
    cmd, kwargs = started[0]
    assert cmd[1:] == ["-m", "app.worker", "--once"]
    assert str(kwargs["cwd"]).endswith("backend")


def test_azure_trigger_posts_to_the_job_start_url(monkeypatch):
    job_id = "/subscriptions/0000/resourceGroups/rg-x/providers/Microsoft.App/jobs/job-worker-x"
    monkeypatch.setattr(get_settings(), "azure_worker_job_id", job_id + "/")
    monkeypatch.setattr(job_trigger, "_managed_identity_token", lambda resource: "tok")
    seen = {}

    def fake_post(url, **kwargs):
        seen["url"], seen["kwargs"] = url, kwargs
        return httpx.Response(202, request=httpx.Request("POST", url))

    monkeypatch.setattr(job_trigger.httpx, "post", fake_post)
    job_trigger._start_azure_job()
    assert seen["url"] == f"https://management.azure.com{job_id}/start"
    assert seen["kwargs"]["params"] == {"api-version": "2024-03-01"}
    assert seen["kwargs"]["headers"] == {"Authorization": "Bearer tok"}


def test_azure_trigger_rejects_a_bad_job_id(monkeypatch):
    monkeypatch.setattr(get_settings(), "azure_worker_job_id", "job-worker-x")
    with pytest.raises(RuntimeError, match="full resource id"):
        job_trigger._start_azure_job()


def test_azure_trigger_http_error_raises(monkeypatch):
    monkeypatch.setattr(get_settings(), "azure_worker_job_id", "/subscriptions/0/resourceGroups/r/providers/Microsoft.App/jobs/j")
    monkeypatch.setattr(job_trigger, "_managed_identity_token", lambda resource: "tok")
    monkeypatch.setattr(
        job_trigger.httpx, "post", lambda url, **kw: httpx.Response(403, request=httpx.Request("POST", url))
    )
    with pytest.raises(httpx.HTTPStatusError):
        job_trigger._start_azure_job()


def test_managed_identity_token_needs_the_platform_variables(monkeypatch):
    monkeypatch.delenv("IDENTITY_ENDPOINT", raising=False)
    monkeypatch.delenv("IDENTITY_HEADER", raising=False)
    with pytest.raises(RuntimeError, match="managed identity"):
        job_trigger._managed_identity_token("https://management.azure.com/")


def test_managed_identity_token_is_read_from_the_endpoint(monkeypatch):
    monkeypatch.setenv("IDENTITY_ENDPOINT", "http://127.0.0.1:42356/msi/token")
    monkeypatch.setenv("IDENTITY_HEADER", "secret-header")
    seen = {}

    def fake_get(url, **kwargs):
        seen["url"], seen["kwargs"] = url, kwargs
        return httpx.Response(200, json={"access_token": "abc"}, request=httpx.Request("GET", url))

    monkeypatch.setattr(job_trigger.httpx, "get", fake_get)
    assert job_trigger._managed_identity_token("https://management.azure.com/") == "abc"
    assert seen["kwargs"]["headers"] == {"X-IDENTITY-HEADER": "secret-header"}
    assert seen["kwargs"]["params"]["resource"] == "https://management.azure.com/"


# ---- the routers call the trigger ------------------------------------------------------


def _upload(client) -> dict:
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    resp = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("aria_pm_2026.pdf", b"%PDF-1.4 fake pm scan", "application/pdf")},
    )
    assert resp.status_code == 201
    return resp.json()


def test_classify_extract_and_approve_notify_the_trigger(client, run_worker, monkeypatch):
    from app.routers import attachments as attachments_router

    calls = []
    monkeypatch.setattr(attachments_router, "notify_job_queued", lambda: calls.append("queued"))
    attachment = _upload(client)
    assert calls == []  # an upload alone queues nothing

    first = client.post(f"/attachments/{attachment['id']}/classify")
    assert first.status_code == 202
    assert calls == ["queued"]

    again = client.post(f"/attachments/{attachment['id']}/classify")  # already unfinished: no new job
    assert again.json()["id"] == first.json()["id"]
    assert calls == ["queued"]

    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    assert calls == ["queued", "queued"]


def test_translate_notifies_the_trigger(client, monkeypatch):
    from app.routers import translations as translations_router

    calls = []
    monkeypatch.setattr(translations_router, "notify_job_queued", lambda: calls.append("queued"))
    attachment = _upload(client)
    resp = client.post(f"/attachments/{attachment['id']}/translate")
    assert resp.status_code in (200, 202)
    assert calls == ["queued"]


class _InlineExecutor:
    """Runs submitted work at once, so a test sees the call without a thread."""

    def submit(self, fn, *args, **kwargs):
        fn(*args, **kwargs)
