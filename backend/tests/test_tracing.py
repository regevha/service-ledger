"""The troubleshooting trace: request ids, one line per request, the job's
lifecycle lines, and the ids that tie them together."""
from __future__ import annotations

import io
import logging

import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import get_settings
from app.main import app
from app.trace import _ContextFilter, bound_job, configure_logging, job_id_var, request_id_var, utc_formatter


@pytest.fixture
def anon():
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _request_lines(caplog):
    return [r for r in caplog.records if r.name == "app.request"]


def test_every_response_carries_a_fresh_request_id(anon):
    first = anon.get("/instruments").headers["x-request-id"]
    second = anon.get("/instruments").headers["x-request-id"]
    assert first != second
    assert len(first) == 12


def test_a_safe_incoming_id_is_kept(anon):
    r = anon.get("/instruments", headers={"X-Request-ID": "tester-42.a_B"})
    assert r.headers["x-request-id"] == "tester-42.a_B"


@pytest.mark.parametrize("bad", ["has space", "x" * 65, "semi;colon", "<script>", "a/b"])
def test_an_unsafe_incoming_id_is_replaced(anon, bad):
    r = anon.get("/instruments", headers={"X-Request-ID": bad})
    assert r.headers["x-request-id"] != bad
    assert len(r.headers["x-request-id"]) == 12


def test_one_line_per_request_with_method_path_status_and_time(anon, caplog):
    caplog.set_level(logging.INFO, logger="app.request")
    anon.get("/instruments")
    lines = _request_lines(caplog)
    assert len(lines) == 1
    assert "GET /instruments -> 200 in " in lines[0].getMessage()


def test_the_query_string_is_never_logged(anon, caplog):
    caplog.set_level(logging.DEBUG, logger="app.request")
    anon.get("/reports?q=customer+secret+name&status=finalized")
    text = " ".join(r.getMessage() for r in _request_lines(caplog))
    assert "/reports" in text
    assert "secret" not in text and "status=" not in text and "?" not in text


def test_health_probes_are_debug_only(anon, caplog):
    caplog.set_level(logging.INFO, logger="app.request")
    anon.get("/health")
    assert not _request_lines(caplog)
    caplog.set_level(logging.DEBUG, logger="app.request")
    anon.get("/health")
    assert len(_request_lines(caplog)) == 1


def test_a_refused_password_is_logged_with_an_id(anon, caplog, monkeypatch):
    monkeypatch.setattr(get_settings(), "shared_password", "a-long-shared-password")
    caplog.set_level(logging.INFO, logger="app.request")
    r = anon.get("/instruments")
    assert r.status_code == 401 and r.headers["x-request-id"]
    assert "-> 401" in _request_lines(caplog)[0].getMessage()


@pytest.fixture
def crashing_route():
    async def _boom():
        raise RuntimeError("deliberate test crash")

    app.add_api_route("/__trace_crash", _boom, methods=["GET"])
    try:
        yield "/__trace_crash"
    finally:
        app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != "/__trace_crash"]


def test_a_500_quotes_the_request_id_everywhere(anon, crashing_route, caplog):
    caplog.set_level(logging.INFO)
    r = anon.get(crashing_route, headers={"X-Request-ID": "ref-abc123"})
    assert r.status_code == 500
    assert r.headers["x-request-id"] == "ref-abc123"
    assert "reference ref-abc123" in r.json()["detail"]
    messages = [rec.getMessage() for rec in caplog.records]
    assert any("Unhandled error on GET /__trace_crash (request ref-abc123)" in m for m in messages)
    assert any("-> 500" in m and "(unhandled error)" in m for m in messages if "/__trace_crash" in m)


def test_the_id_is_not_left_set_after_the_request(anon):
    anon.get("/instruments")
    assert request_id_var.get() == "-"


def _upload_and_classify(client, name="aria_pm_2026.pdf"):
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": (name, b"%PDF-1.4 fake pm scan", "application/pdf")},
    ).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    return report, attachment, job


def test_queueing_a_job_logs_its_id_with_the_request_id(client, caplog):
    caplog.set_level(logging.INFO)
    _, attachment, job = _upload_and_classify(client)
    queued = [r.getMessage() for r in caplog.records if "Queued classify job" in r.getMessage()]
    assert queued == [f"Queued classify job {job['id']} for attachment {attachment['id']}"]


def test_a_job_logs_start_and_finish_and_binds_its_ids(client, run_worker, caplog, monkeypatch):
    seen = {}
    from app import worker

    real = worker._run_classify_job

    def spy(db, job):
        from app.trace import attachment_id_var, report_id_var
        seen.update(job=job_id_var.get(), report=report_id_var.get(), attachment=attachment_id_var.get())
        return real(db, job)

    monkeypatch.setattr(worker, "_run_classify_job", spy)
    caplog.set_level(logging.INFO)
    report, attachment, job = _upload_and_classify(client)
    run_worker()

    assert seen == {"job": job["id"], "report": report["id"], "attachment": attachment["id"]}
    messages = [r.getMessage() for r in caplog.records if r.name == "app.worker"]
    assert any(m.startswith(f"Job {job['id']} started (kind=classify, queued ") for m in messages)
    assert any(m.startswith(f"Job {job['id']} finished: succeeded in ") for m in messages)
    assert job_id_var.get() == "-"  # unbound again after the job


def test_a_failing_job_still_logs_its_outcome(client, run_worker, caplog, monkeypatch):
    from app import worker

    def boom(db, job):
        raise RuntimeError("deliberate worker crash")

    monkeypatch.setattr(worker, "_run_classify_job", boom)
    caplog.set_level(logging.INFO)
    _, _, job = _upload_and_classify(client)
    run_worker()
    messages = [r.getMessage() for r in caplog.records]
    assert any("Unhandled error processing extraction job" in m for m in messages)
    assert any(m.startswith(f"Job {job['id']} finished: failed in ") for m in messages)


def test_the_format_shows_the_ids_and_the_role():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(utc_formatter())
    handler.addFilter(_ContextFilter("worker"))
    log = logging.getLogger("test.trace.format")
    log.propagate = False
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    try:
        log.info("outside")
        with bound_job("job-1", "rep-1", "att-1"):
            token = request_id_var.set("req-9")
            try:
                log.info("inside")
            finally:
                request_id_var.reset(token)
    finally:
        log.removeHandler(handler)
    outside, inside = stream.getvalue().splitlines()
    import re
    assert re.match(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}Z INFO worker ", outside)
    assert "worker [req=- job=-] test.trace.format: outside" in outside
    assert "worker [req=req-9 job=job-1] test.trace.format: inside" in inside


def test_configure_logging_adds_one_handler_and_updates_the_role():
    root = logging.getLogger()
    before = [h for h in root.handlers if getattr(h, "_service_ledger_trace_handler", False)]
    configure_logging("api")
    configure_logging("worker")
    configure_logging("worker")
    ours = [h for h in root.handlers if getattr(h, "_service_ledger_trace_handler", False)]
    assert len(ours) == max(1, len(before))
    roles = [f.role for h in ours for f in h.filters if isinstance(f, _ContextFilter)]
    assert roles == ["worker"]
    configure_logging("api")  # leave it as the API configured it


def test_console_times_are_utc_whatever_the_machine_zone(monkeypatch):
    import os
    import time as _time

    monkeypatch.setenv("TZ", "Asia/Jerusalem")
    _time.tzset()
    try:
        record = logging.LogRecord("x", logging.INFO, "f", 1, "m", None, None)
        record.created, record.msecs = 1_700_000_000.0, 0  # 2023-11-14 22:13:20 UTC
        record.role, record.request_id, record.job_id = "api", "-", "-"
        assert utc_formatter().format(record).startswith("2023-11-14 22:13:20,000Z")
    finally:
        monkeypatch.delenv("TZ", raising=False)
        _time.tzset()


def test_successful_job_polls_are_debug_only_but_failures_are_not(client, caplog):
    caplog.set_level(logging.INFO, logger="app.request")
    _, _, job = _upload_and_classify(client)
    caplog.clear()
    assert client.get(f"/extraction-jobs/{job['id']}").status_code == 200
    assert not _request_lines(caplog)
    assert client.get("/extraction-jobs/00000000-0000-0000-0000-000000000000").status_code == 404
    assert "-> 404" in _request_lines(caplog)[0].getMessage()
    caplog.clear()
    client.post(f"/attachments/{job['attachment_id']}/classify")  # a POST is never routine
    assert any("POST" in r.getMessage() for r in _request_lines(caplog))
