"""Unit tests for the live-Claude response-parsing logic in
classification.py's _live_classify and extraction.py's _live_extract.

Per the project's test-gap analysis: test_live_claude_failures.py monkeypatches
`app.worker.run_classify`/`run_extract` — i.e. it replaces the *entire*
function — so nothing inside _live_classify/_live_extract has ever executed
under any test. That's exactly the code both files' own comments flag as
fragile: the AuthenticationError/APIError catch blocks, the "no tool_use
block" StopIteration guard, and — the sharpest edge, per extraction.py's
comments about what a live trial run actually showed the model do —
_resolve_extraction_data's single-key unwrap and the per-field
{"value":..., "confidence":...} rescue.

These tests stub only the Anthropic client's `.messages.create()` call (never
a real API call — conftest.py's USE_LIVE_CLAUDE=false doesn't even apply
here, since _live_classify/_live_extract are called directly rather than
through classify()/extract()) and exercise the real parsing code around it.
"""
from __future__ import annotations

import logging
import re
from types import SimpleNamespace

import anthropic
import httpx
import pytest

from app.services import classification, extraction
from app.services.errors import ClassificationError, ExtractionError

# ---------- shared fakes ----------


class _FakeMessages:
    def __init__(self, response=None, exception=None):
        self._response = response
        self._exception = exception
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._exception:
            raise self._exception
        return self._response


class _FakeClient:
    def __init__(self, response=None, exception=None):
        self.messages = _FakeMessages(response=response, exception=exception)


def _tool_use_response(input_dict: dict):
    return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=input_dict)])


def _text_only_response(text: str = "I looked at the document."):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


def _auth_error() -> anthropic.AuthenticationError:
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    resp = httpx.Response(401, request=req)
    return anthropic.AuthenticationError("invalid x-api-key", response=resp, body=None)


def _connection_error() -> anthropic.APIConnectionError:
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.APIConnectionError(message="connection reset", request=req)


# Matches the "%.2fs" duration every call-timing log line renders, e.g. "0.00s".
_DURATION_RE = re.compile(r"\d+\.\d\ds")


# ================= classification._live_classify =================


def test_live_classify_parses_a_well_formed_tool_response(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake scan")
    attachment = SimpleNamespace(file_path=str(pdf))
    instruments = [SimpleNamespace(model="LSRFortessa"), SimpleNamespace(model="FACSAria III")]

    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "instrument_model": "LSRFortessa",
                "instrument_confidence": 0.93,
                "report_type": "repair",
                "report_type_confidence": 0.6,
            }
        )
    )
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    instrument_guess, type_guess = classification._live_classify(None, attachment, instruments)

    assert instrument_guess.value == "LSRFortessa"
    assert instrument_guess.confidence == 0.93
    assert type_guess.value == "repair"
    assert type_guess.confidence == 0.6

    # The model options offered to Claude should be exactly the fleet passed
    # in (sorted), and the tool_choice should force this exact tool — both
    # load-bearing for getting a validated answer back rather than free text.
    call = fake_client.messages.calls[0]
    assert call["tool_choice"] == {"type": "tool", "name": classification._CLASSIFY_TOOL_NAME}
    assert call["tools"][0]["input_schema"]["properties"]["instrument_model"]["enum"] == [
        "FACSAria III",
        "LSRFortessa",
    ]

    # Every live Claude call gets one completion log line with how long it
    # took — the fake response has no .usage (the SimpleNamespace test
    # double doesn't set one), so input/output tokens degrade to "?" rather
    # than blowing up.
    assert "Claude classify API call" in caplog.text
    assert _DURATION_RE.search(caplog.text)
    assert "input_tokens=?" in caplog.text


def test_live_classify_wraps_authentication_error(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(exception=_auth_error())
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    with pytest.raises(ClassificationError, match="authentication failed"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])

    # The router/worker only ever store str(e) on the job row — this is what
    # makes an auth failure visible anywhere a human would actually look
    # while debugging live, rather than only inside the database. A failed
    # call still gets timed — "how long before it gave up" is exactly what
    # you want to know when a job is stuck.
    assert "authentication failed" in caplog.text
    assert str(pdf) in caplog.text
    assert _DURATION_RE.search(caplog.text)


def test_live_classify_wraps_a_generic_api_error(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(exception=_connection_error())
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    with pytest.raises(ClassificationError, match="Claude API request failed during classification"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])

    assert "Claude API request failed" in caplog.text
    assert str(pdf) in caplog.text
    assert _DURATION_RE.search(caplog.text)


def test_live_classify_raises_when_claude_answers_without_a_tool_call(tmp_path, monkeypatch, caplog):
    """Tool use is forced via tool_choice, but the SDK doesn't guarantee the
    model actually honors it — this is the StopIteration guard's whole
    reason to exist."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(response=_text_only_response())
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    with pytest.raises(ClassificationError, match="no tool_use block"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])

    assert "no tool_use block" in caplog.text
    assert "'text'" in caplog.text  # the block types actually returned, for diagnosis


def test_live_classify_raises_on_a_missing_field_in_the_tool_response(tmp_path, monkeypatch, caplog):
    """Tool-use input isn't strictly validated against the schema (see this
    file's real-world comments) — a response missing a required key is a
    genuine failure mode, not just defensive paranoia."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response({"instrument_model": "LSRFortessa", "instrument_confidence": 0.9})
        # report_type / report_type_confidence missing entirely.
    )
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    with pytest.raises(ClassificationError, match="missing or malformed fields"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])

    assert "missing or malformed fields" in caplog.text
    assert "instrument_model" in caplog.text  # the raw tool input, for diagnosis


def test_live_classify_raises_on_a_non_numeric_confidence(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "instrument_model": "LSRFortessa",
                "instrument_confidence": "very sure",  # not a float
                "report_type": "repair",
                "report_type_confidence": 0.6,
            }
        )
    )
    monkeypatch.setattr(classification, "_get_client", lambda: fake_client)

    with pytest.raises(ClassificationError, match="missing or malformed fields"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])

    assert "missing or malformed fields" in caplog.text
    assert "very sure" in caplog.text  # the raw tool input, for diagnosis


# ================= extraction._live_extract =================

_FIELDS = [
    {"name": "fault_description", "type": "text", "unit": None, "notes": None},
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": None},
    {"name": "retest_result", "type": "enum", "unit": None, "notes": None, "options": ["pass", "fail"]},
]


def _template(fields=_FIELDS):
    return SimpleNamespace(field_schema={"fields": fields})


def test_live_extract_parses_a_well_formed_flat_response(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.INFO)
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake scan")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "fault_description": "No see events",
                "fault_description__confidence": 0.92,
                "labor_hours": 11.5,
                "labor_hours__confidence": 0.88,
                "retest_result": "pass",
                "retest_result__confidence": 0.95,
            }
        )
    )
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    fields, confidences = extraction._live_extract(attachment, _template())

    assert fields == {"fault_description": "No see events", "labor_hours": 11.5, "retest_result": "pass"}
    assert confidences == {"fault_description": 0.92, "labor_hours": 0.88, "retest_result": 0.95}

    assert "Claude extract API call" in caplog.text
    assert _DURATION_RE.search(caplog.text)
    assert "input_tokens=?" in caplog.text


def test_live_extract_unwraps_a_single_key_wrapped_response(tmp_path, monkeypatch):
    """A live run showed the model sometimes wraps its entire answer under
    one extra top-level key (e.g. {"value": {...all fields...}}) instead of
    answering flat as the schema asks — _resolve_extraction_data's whole
    reason to exist, and never exercised by any prior test."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    inner = {
        "fault_description": "No see events",
        "fault_description__confidence": 0.9,
        "labor_hours": 4.0,
        "labor_hours__confidence": 0.8,
        "retest_result": "pass",
        "retest_result__confidence": 0.9,
    }
    fake_client = _FakeClient(response=_tool_use_response({"value": inner}))
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    fields, confidences = extraction._live_extract(attachment, _template())

    assert fields["fault_description"] == "No see events"
    assert fields["labor_hours"] == 4.0
    assert confidences["labor_hours"] == 0.8


def test_live_extract_rescues_a_per_field_nested_value_confidence_shape(tmp_path, monkeypatch):
    """Even with a flat schema, a live run showed the model occasionally
    answers one field as {"value": ..., "confidence": ...} anyway — recover
    that shape rather than trusting only the schema's own flat shape."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "fault_description": {"value": "No see events", "confidence": 0.91},
                "labor_hours": 4.0,
                "labor_hours__confidence": 0.8,
                "retest_result": "pass",
                "retest_result__confidence": 0.9,
            }
        )
    )
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    fields, confidences = extraction._live_extract(attachment, _template())

    assert fields["fault_description"] == "No see events"
    assert confidences["fault_description"] == 0.91


def test_live_extract_defaults_a_missing_field_to_none_value_and_zero_confidence(tmp_path, monkeypatch):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "fault_description": "No see events",
                "fault_description__confidence": 0.9,
                "retest_result": "pass",
                "retest_result__confidence": 0.9,
                # labor_hours / labor_hours__confidence entirely absent.
            }
        )
    )
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    fields, confidences = extraction._live_extract(attachment, _template())

    assert fields["labor_hours"] is None
    assert confidences["labor_hours"] == 0.0


def test_live_extract_treats_a_non_numeric_confidence_as_zero_without_dropping_the_value(tmp_path, monkeypatch, caplog):
    """A non-numeric confidence shouldn't sink the whole extraction (per
    extraction.py's own comment) — it degrades to 'couldn't tell' but the
    value is kept. This is Claude's tool call not honoring its own schema,
    so it's still worth a log line even though nothing raises."""
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(
        response=_tool_use_response(
            {
                "fault_description": "No see events",
                "fault_description__confidence": "high",  # not a float
                "labor_hours": 4.0,
                "labor_hours__confidence": 0.8,
                "retest_result": "pass",
                "retest_result__confidence": 0.9,
            }
        )
    )
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    fields, confidences = extraction._live_extract(attachment, _template())

    assert fields["fault_description"] == "No see events"
    assert confidences["fault_description"] == 0.0
    assert "Non-numeric confidence" in caplog.text
    assert "fault_description" in caplog.text


def test_live_extract_wraps_authentication_error(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(exception=_auth_error())
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    with pytest.raises(ExtractionError, match="authentication failed"):
        extraction._live_extract(attachment, _template())

    assert "authentication failed" in caplog.text
    assert str(pdf) in caplog.text
    assert _DURATION_RE.search(caplog.text)


def test_live_extract_wraps_a_generic_api_error(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(exception=_connection_error())
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    with pytest.raises(ExtractionError, match="Claude API request failed during extraction"):
        extraction._live_extract(attachment, _template())

    assert "Claude API request failed" in caplog.text
    assert str(pdf) in caplog.text
    assert _DURATION_RE.search(caplog.text)


def test_live_extract_raises_when_claude_answers_without_a_tool_call(tmp_path, monkeypatch, caplog):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    attachment = SimpleNamespace(file_path=str(pdf))
    fake_client = _FakeClient(response=_text_only_response())
    monkeypatch.setattr(extraction, "_get_client", lambda: fake_client)

    with pytest.raises(ExtractionError, match="no tool_use block"):
        extraction._live_extract(attachment, _template())

    assert "no tool_use block" in caplog.text
    assert "'text'" in caplog.text
