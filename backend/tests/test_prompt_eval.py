"""scripts/prompt_eval.py: builds prompts without a call (dry run) and scores answers."""
from __future__ import annotations

import json
from types import SimpleNamespace

from app.services import classification, claude_client, extraction
from scripts import prompt_eval


def _fake_client(tool_input: dict):
    class _Messages:
        def create(self, **kwargs):
            return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=tool_input)], stop_reason="tool_use")

    return SimpleNamespace(messages=_Messages())


def _case(tmp_path, spec: dict):
    (tmp_path / "doc.pdf").write_bytes(b"%PDF-1.4 fake")
    path = tmp_path / "doc.expected.json"
    path.write_text(json.dumps({"file": "doc.pdf", **spec}))
    return path


def test_dry_run_builds_the_prompt_and_calls_nothing(tmp_path, monkeypatch):
    class _Never:
        def create(self, **kwargs):
            raise AssertionError("no Claude call in a dry run")

    monkeypatch.setattr(classification, "_get_client", lambda: SimpleNamespace(messages=_Never()))
    monkeypatch.setattr(claude_client.settings, "view_prompts", False)
    path = _case(tmp_path, {"classify": {"instrument_model": "FACSAria III"}})
    checks, hashes = prompt_eval.run_case(path, dry_run=True)
    assert checks == [] and len(hashes["classify"]) == 12


def test_classify_answers_are_scored(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_client.settings, "view_prompts", False)
    monkeypatch.setattr(classification, "_get_client", lambda: _fake_client({
        "instrument_model": "FACSAria III", "instrument_confidence": 0.95,
        "report_type": "repair", "report_type_confidence": 0.9,
        "instrument_serial": "P648282B3003", "instrument_serial_confidence": 0.9,
        "task_code": "T113", "task_code_confidence": 0.95, "work_order_number": "WO-04215114",
    }))
    path = _case(tmp_path, {"classify": {
        "instrument_model": "FACSAria III", "report_type": "repair",
        "serial": "p648282b3003", "work_order": "WO-04215115"}})
    checks, _ = prompt_eval.run_case(path, dry_run=False)
    result = {name: ok for name, ok, _, _ in checks}
    assert result == {"classify.instrument_model": True, "classify.report_type": True,
                      "classify.serial": True, "classify.work_order": False}


def test_extract_fields_and_date_are_scored(tmp_path, monkeypatch):
    monkeypatch.setattr(claude_client.settings, "view_prompts", False)
    monkeypatch.setattr(extraction, "_get_client", lambda: _fake_client({
        "fault_description": "x", "fault_description__confidence": 0.9,
        "labor_hours": 3.5, "labor_hours__confidence": 0.9,
        "report_date": "2026-01-15", "report_date__confidence": 0.9,
    }))
    path = _case(tmp_path, {"extract": {
        "report_type": "repair", "fields": {"labor_hours": 3.5, "fault_description": "y"},
        "report_date": "2026-01-15"}})
    checks, hashes = prompt_eval.run_case(path, dry_run=False)
    result = {name: ok for name, ok, _, _ in checks}
    assert result == {"extract.labor_hours": True, "extract.fault_description": False, "extract.report_date": True}
    assert "extract" in hashes
