"""The Claude call debug log: off unless the owner turns it on, never stores a
document or a key, never fails a call, and cleans up after itself."""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import stat
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from pydantic import ValidationError

from app import debug_claude_log
from app.config import Settings, get_settings
from app.debug_claude_log import announce_debug_log, level, log_dir, record_call
from app.services.claude_client import call_claude_tool
from app.services.errors import ClassificationError
from app.trace import bound_job

PDF_BYTES = b"%PDF-1.4 SECRET-DOCUMENT-BODY customer Acme serial R647794E6092"
KEY = "sk-ant-api03-SECRETKEYVALUE1234567890"
PROMPT_MARK = "UNIQUE-PROMPT-MARKER-7731"
SCHEMA_MARK = "unique_schema_property_5520"
SYSTEM_MARK = "UNIQUE-SYSTEM-MARKER-1188"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "debug_claude_log", "")
    monkeypatch.setattr(s, "debug_claude_log_dir", str(tmp_path / "dbg"))
    monkeypatch.setattr(s, "debug_claude_log_days", 7)
    monkeypatch.setattr(s, "anthropic_api_key", KEY)
    monkeypatch.setattr(debug_claude_log, "_last_purge", None)
    return tmp_path / "dbg"


def _kwargs():
    return dict(
        model="claude-test",
        max_tokens=1024,
        system=SYSTEM_MARK,
        tools=[{"name": "classify_report", "description": "d", "input_schema": {"type": "object", "properties": {SCHEMA_MARK: {"type": "string"}}}}],
        tool_choice={"type": "tool", "name": "classify_report"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(PDF_BYTES).decode()}},
                {"type": "text", "text": f"Read this form. {PROMPT_MARK}"},
            ],
        }],
    )


def _response():
    return SimpleNamespace(
        stop_reason="tool_use",
        _request_id="req_01ABC",
        usage=SimpleNamespace(input_tokens=1200, output_tokens=85, cache_read_input_tokens=0, cache_creation_input_tokens=None),
        content=[SimpleNamespace(type="tool_use", name="classify_report", input={"instrument_model": "LSRFortessa", "instrument_confidence": 0.93})],
    )


class _Client:
    def __init__(self, response=None, error=None):
        self.messages = SimpleNamespace(create=self._create)
        self._response, self._error = response, error

    def _create(self, **kwargs):
        if self._error:
            raise self._error
        return self._response


def _call(client, verb="classify"):
    return call_claude_tool(
        client=client, request_kwargs=_kwargs(), error_cls=ClassificationError, logger=logging.getLogger("test"),
        attachment_path="/data/attachments/rep/uuid_scan.pdf", verb=verb, gerund="classifying", noun="classification",
    )


def _lines(directory):
    files = sorted(directory.glob("claude-calls-*.jsonl"))
    return [json.loads(line) for f in files for line in f.read_text().splitlines()]


def _text(directory):
    return "".join(f.read_text() for f in directory.glob("claude-calls-*.jsonl"))


# ---- off by default

def test_off_by_default_writes_nothing_and_builds_nothing(_isolated, monkeypatch):
    called = []
    monkeypatch.setattr(debug_claude_log, "_describe_request", lambda *a, **k: called.append(1))
    monkeypatch.setattr(debug_claude_log, "_describe_response", lambda *a, **k: called.append(1))
    _call(_Client(response=_response()))
    assert not called
    assert not _isolated.exists()


# ---- light level

def test_light_records_one_line_per_call_without_prompt_schema_or_document(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    with bound_job("job-1", "rep-1", "att-1"):
        _call(_Client(response=_response()))
        _call(_Client(response=_response()), verb="extract")
    records = _lines(_isolated)
    assert [r["kind"] for r in records] == ["classify", "extract"]
    r = records[0]
    assert (r["level"], r["job_id"], r["report_id"], r["attachment_id"], r["file"]) == ("light", "job-1", "rep-1", "att-1", "uuid_scan.pdf")
    assert r["request"]["model"] == "claude-test"
    assert r["request"]["tools"] == ["classify_report"]
    assert r["request"]["documents"] == [{
        "type": "document", "media_type": "application/pdf", "bytes": len(PDF_BYTES), "sha256": hashlib.sha256(PDF_BYTES).hexdigest()}]
    assert r["request"]["text_chars"] == [len(f"Read this form. {PROMPT_MARK}")]
    assert r["response"]["stop_reason"] == "tool_use"
    assert r["response"]["anthropic_request_id"] == "req_01ABC"
    assert r["response"]["usage"]["input_tokens"] == 1200
    assert r["response"]["content"] == [{"type": "tool_use", "name": "classify_report", "input": {"instrument_model": "LSRFortessa", "instrument_confidence": 0.93}}]
    assert r["elapsed_seconds"] >= 0
    text = _text(_isolated)
    for forbidden in (PROMPT_MARK, SCHEMA_MARK, SYSTEM_MARK, base64.b64encode(PDF_BYTES).decode(), "SECRET-DOCUMENT-BODY"):
        assert forbidden not in text


def test_the_call_returns_the_response_unchanged(monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    resp = _response()
    assert _call(_Client(response=resp)) is resp


# ---- deep level

def test_deep_adds_prompt_system_and_schema_but_still_no_document(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "DEEP")
    _call(_Client(response=_response()))
    r = _lines(_isolated)[0]
    assert r["level"] == "deep"
    assert r["request"]["system"] == SYSTEM_MARK
    assert r["request"]["prompt_text"] == [f"Read this form. {PROMPT_MARK}"]
    assert SCHEMA_MARK in json.dumps(r["request"]["tool_schemas"])
    text = _text(_isolated)
    assert base64.b64encode(PDF_BYTES).decode() not in text and "SECRET-DOCUMENT-BODY" not in text


# ---- the key

def test_the_api_key_is_never_written(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "deep")
    kwargs = _kwargs()
    kwargs["messages"][0]["content"][1]["text"] = f"my key is {KEY} and another sk-ant-api03-OTHERKEY987654321"
    record_call(verb="classify", request_kwargs=kwargs, response=_response(), elapsed_seconds=0.1, attachment_path="x.pdf")
    text = _text(_isolated)
    assert KEY not in text and "OTHERKEY" not in text and "[redacted]" in text


def test_a_key_that_does_not_look_like_an_anthropic_key_is_scrubbed_too(_isolated, monkeypatch):
    """A gateway or proxy key has no sk-ant- shape; the exact configured key is removed."""
    odd = "gateway-token-QWERTY-asdfgh-123456"
    monkeypatch.setattr(get_settings(), "anthropic_api_key", odd)
    monkeypatch.setattr(get_settings(), "debug_claude_log", "deep")
    kwargs = _kwargs()
    kwargs["messages"][0]["content"][1]["text"] = f"token {odd} leaked"
    record_call(verb="classify", request_kwargs=kwargs, response=_response(), elapsed_seconds=0.1, attachment_path="x.pdf")
    text = _text(_isolated)
    assert odd not in text and "[redacted]" in text


def test_an_error_message_with_the_key_is_scrubbed(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    err = anthropic.APIConnectionError(request=httpx.Request("POST", "http://x"))
    err.args = (f"failed with {KEY}",)
    err.message = f"failed with {KEY}"
    with pytest.raises(ClassificationError):
        _call(_Client(error=err))
    assert KEY not in _text(_isolated)


# ---- errors

def test_a_failed_call_is_recorded_and_still_raises_the_service_error(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    request = httpx.Request("POST", "http://x")
    with pytest.raises(ClassificationError, match="authentication failed"):
        _call(_Client(error=anthropic.AuthenticationError("bad key", response=httpx.Response(401, request=request), body=None)))
    with pytest.raises(ClassificationError, match="request failed"):
        _call(_Client(error=anthropic.APIConnectionError(request=request)))
    records = _lines(_isolated)
    assert [r["error"]["type"] for r in records] == ["AuthenticationError", "APIConnectionError"]
    assert all("response" not in r for r in records)


# ---- isolation

def test_a_broken_log_never_fails_the_call(_isolated, monkeypatch, caplog):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    _isolated.parent.mkdir(parents=True, exist_ok=True)
    _isolated.write_text("this is a file, not a folder")  # the log folder cannot be created
    caplog.set_level(logging.WARNING, logger="app.debug_claude_log")
    resp = _response()
    assert _call(_Client(response=resp)) is resp
    assert any("Could not write the Claude debug log record" in r.getMessage() for r in caplog.records)


def test_a_failure_while_describing_does_not_fail_the_call(monkeypatch, caplog):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")

    def boom(*a, **k):
        raise RuntimeError("describe failed")

    monkeypatch.setattr(debug_claude_log, "_describe_response", boom)
    caplog.set_level(logging.WARNING, logger="app.debug_claude_log")
    resp = _response()
    assert _call(_Client(response=resp)) is resp
    assert any("describe failed" in r.getMessage() for r in caplog.records)


# ---- files

def test_the_folder_and_files_are_private(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    _call(_Client(response=_response()))
    assert stat.S_IMODE(os.stat(_isolated).st_mode) == 0o700
    f = next(_isolated.glob("claude-calls-*.jsonl"))
    assert stat.S_IMODE(os.stat(f).st_mode) == 0o600
    assert f.name == f"claude-calls-{datetime.now(timezone.utc).date().isoformat()}.jsonl"


def test_files_older_than_the_retention_are_deleted_once_a_day(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    _isolated.mkdir(parents=True)
    today = datetime.now(timezone.utc).date()

    def make(days_ago):
        p = _isolated / f"claude-calls-{(today - timedelta(days=days_ago)).isoformat()}.jsonl"
        p.write_text("{}\n")
        return p

    old, borderline, recent = make(8), make(7), make(1)
    other = _isolated / "notes.txt"
    other.write_text("keep me")
    _call(_Client(response=_response()))
    assert not old.exists()
    assert borderline.exists() and recent.exists() and other.exists()
    # a second call the same day does not scan again
    again = make(30)
    _call(_Client(response=_response()))
    assert again.exists()


def test_calls_append_to_the_same_days_file(_isolated, monkeypatch):
    monkeypatch.setattr(get_settings(), "debug_claude_log", "light")
    for _ in range(3):
        _call(_Client(response=_response()))
    files = list(_isolated.glob("claude-calls-*.jsonl"))
    assert len(files) == 1 and len(files[0].read_text().splitlines()) == 3


def test_the_default_folder_sits_next_to_the_attachments(monkeypatch, tmp_path):
    s = get_settings()
    monkeypatch.setattr(s, "debug_claude_log_dir", "")
    monkeypatch.setattr(s, "attachment_storage_dir", str(tmp_path / "data" / "attachments"))
    assert log_dir() == (tmp_path / "data").resolve() / "debug-claude"


# ---- the switch

@pytest.mark.parametrize("value,expected", [("", ""), ("light", "light"), ("deep", "deep"), ("DEEP", "deep"), ("true", "light"), ("1", "light"), (" on ", "light"), ("verbose", ""), ("false", ""), ("0", "")])
def test_the_setting_values(monkeypatch, value, expected):
    monkeypatch.setattr(get_settings(), "debug_claude_log", value)
    assert level() == expected


def test_the_startup_announcement(monkeypatch, caplog, _isolated):
    s = get_settings()
    caplog.set_level(logging.WARNING, logger="app.debug_claude_log")
    announce_debug_log()
    assert not caplog.records  # off: silent

    monkeypatch.setattr(s, "debug_claude_log", "deep")
    monkeypatch.setattr(s, "use_live_claude", True)
    announce_debug_log()
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "debug log is ON (level=deep)" in text and str(_isolated) in text and "7 days" in text
    assert "stub mode" not in text

    caplog.clear()
    monkeypatch.setattr(s, "use_live_claude", False)
    announce_debug_log()
    assert "stub mode" in " ".join(r.getMessage() for r in caplog.records)

    caplog.clear()
    monkeypatch.setattr(s, "debug_claude_log", "verbose")
    announce_debug_log()
    assert "not understood" in caplog.records[0].getMessage() and "OFF" in caplog.records[0].getMessage()


@pytest.mark.parametrize("days", [0, -1, 91])
def test_the_retention_must_be_between_1_and_90_days(days):
    with pytest.raises(ValidationError, match="between 1 and 90"):
        Settings(_env_file=None, debug_claude_log_days=days)
    assert Settings(_env_file=None, debug_claude_log_days=1).debug_claude_log_days == 1
    assert Settings(_env_file=None, debug_claude_log_days=90).debug_claude_log_days == 90
