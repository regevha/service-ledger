"""Cancel on the intake screen: a job that has not started is never run, a job that is running
has its result thrown away, and neither leaves anything behind. Only a finished job is refused."""
from __future__ import annotations

from types import SimpleNamespace

from app.services import claude_client, classification

TOOL_INPUT = {
    "instrument_model": "LSRFortessa", "instrument_confidence": 0.95,
    "report_type": "repair", "report_type_confidence": 0.92,
}


class _Messages:
    """A stand-in for the Claude client. `during` runs in the middle of the call, which is when
    the person presses Cancel."""

    def __init__(self, during=None):
        self.calls = 0
        self.during = during

    def create(self, **kwargs):
        self.calls += 1
        if self.during:
            self.during()
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=TOOL_INPUT)])


def _setup(client, monkeypatch, during=None):
    monkeypatch.setattr(classification.settings, "use_live_claude", True)
    monkeypatch.setattr(claude_client.settings, "view_prompts", False)
    fake = SimpleNamespace(messages=_Messages())
    monkeypatch.setattr(classification, "_get_client", lambda: fake)
    report = client.post("/reports", json={"technician_name": "Cancel"}).json()
    att = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 cancel", "application/pdf")},
    ).json()
    job = client.post(f"/attachments/{att['id']}/classify").json()
    if during:
        fake.messages.during = lambda: during(report["id"], job["id"])
    return fake, report["id"], job["id"]


def test_cancelling_a_job_that_has_not_started_means_nothing_is_sent(client, run_worker, monkeypatch):
    fake, _report_id, job_id = _setup(client, monkeypatch)
    cancelled = client.post(f"/extraction-jobs/{job_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "failed" and cancelled.json()["error_message"] == "Cancelled."
    run_worker()
    assert fake.messages.calls == 0


def test_cancelling_during_the_call_throws_the_result_away(client, run_worker, monkeypatch):
    fake, report_id, job_id = _setup(
        client, monkeypatch, during=lambda _report, job: client.post(f"/extraction-jobs/{job}/cancel")
    )
    run_worker()
    assert fake.messages.calls == 1  # it was already running; the call could not be taken back
    job = client.get(f"/extraction-jobs/{job_id}").json()
    assert job["status"] == "failed" and job["error_message"] == "Cancelled."
    assert job["classification"] is None
    report = client.get(f"/reports/{report_id}").json()
    assert report["instrument_id"] is None and report["template_id"] is None and report["status"] == "draft"


def test_cancelling_and_deleting_the_draft_during_the_call_is_quiet(client, run_worker, monkeypatch):
    def cancel_and_delete(report_id, job_id):
        assert client.post(f"/extraction-jobs/{job_id}/cancel").status_code == 200
        assert client.delete(f"/reports/{report_id}").status_code == 204

    _fake, report_id, job_id = _setup(client, monkeypatch, during=cancel_and_delete)
    run_worker()  # must not raise or wedge the queue
    assert client.get(f"/reports/{report_id}").status_code == 404
    assert client.get(f"/extraction-jobs/{job_id}").status_code == 404


def test_cancelling_a_finished_job_is_refused(client, run_worker, monkeypatch):
    _fake, _report_id, job_id = _setup(client, monkeypatch)
    run_worker()
    assert client.get(f"/extraction-jobs/{job_id}").json()["status"] == "succeeded"
    assert client.post(f"/extraction-jobs/{job_id}/cancel").status_code == 409
    assert client.post("/extraction-jobs/00000000-0000-0000-0000-000000000000/cancel").status_code == 404
