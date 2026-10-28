"""VIEW_PROMPTS: a live Claude call stops until a person presses Send or Cancel."""
from __future__ import annotations

from types import SimpleNamespace

from app.services import claude_client, classification
from app.services.prompt_gate import build_preview


class _FakeMessages:
    def __init__(self):
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input={
            "instrument_model": "LSRFortessa", "instrument_confidence": 0.95,
            "report_type": "repair", "report_type_confidence": 0.92,
        })])


def _setup(client, monkeypatch, preview=True):
    monkeypatch.setattr(classification.settings, "use_live_claude", True)
    monkeypatch.setattr(claude_client.settings, "view_prompts", preview)
    fake = SimpleNamespace(messages=_FakeMessages())
    monkeypatch.setattr(classification, "_get_client", lambda: fake)
    report = client.post("/reports", json={"technician_name": "Preview"}).json()
    att = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 fake", "application/pdf")},
    ).json()
    job = client.post(f"/attachments/{att['id']}/classify").json()
    return fake, job["id"]


def test_job_stops_before_the_call_and_shows_the_prompt(client, run_worker, monkeypatch):
    fake, job_id = _setup(client, monkeypatch)
    run_worker()
    job = client.get(f"/extraction-jobs/{job_id}").json()
    assert job["status"] == "awaiting_approval"
    assert fake.messages.calls == []
    preview = job["prompt_preview"]
    assert preview["verb"] == "classify" and preview["model"]
    assert any(b["type"] == "document" and b["sha256"] for b in preview["blocks"])
    assert any(b["type"] == "text" and b["text"] for b in preview["blocks"])
    assert preview["tools"]


def test_send_makes_the_call_and_finishes_the_job(client, run_worker, monkeypatch):
    fake, job_id = _setup(client, monkeypatch)
    run_worker()
    approved = client.post(f"/extraction-jobs/{job_id}/approve")
    assert approved.status_code == 200 and approved.json()["status"] == "pending"
    run_worker()
    assert len(fake.messages.calls) == 1
    assert client.get(f"/extraction-jobs/{job_id}").json()["status"] == "succeeded"


def test_cancel_sends_nothing_and_fails_the_job(client, run_worker, monkeypatch):
    fake, job_id = _setup(client, monkeypatch)
    run_worker()
    cancelled = client.post(f"/extraction-jobs/{job_id}/cancel").json()
    assert cancelled["status"] == "failed" and "Cancelled" in cancelled["error_message"]
    run_worker()
    assert fake.messages.calls == []


def test_approve_and_cancel_need_a_waiting_job(client, run_worker, monkeypatch):
    fake, job_id = _setup(client, monkeypatch)  # still pending, not waiting
    assert client.post(f"/extraction-jobs/{job_id}/approve").status_code == 409
    assert client.post(f"/extraction-jobs/{job_id}/cancel").status_code == 409


def test_off_by_default_calls_straight_through(client, run_worker, monkeypatch):
    fake, job_id = _setup(client, monkeypatch, preview=False)
    run_worker()
    assert len(fake.messages.calls) == 1
    assert client.get(f"/extraction-jobs/{job_id}").json()["prompt_preview"] is None


def test_preview_never_contains_document_bytes():
    kwargs = {"model": "m", "messages": [{"role": "user", "content": [
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "SGVsbG8="}},
        {"type": "text", "text": "hi"}]}]}
    out = str(build_preview(kwargs, "classify"))
    assert "SGVsbG8=" not in out and "'bytes': 5" in out
