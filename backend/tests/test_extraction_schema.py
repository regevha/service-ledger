"""Schema-shape tests for extract()'s live-path tool schema builder.

These don't call the Claude API (conftest.py forces USE_LIVE_CLAUDE=false for
the whole suite) — they cover a real gap instead: none of the 6 real sample
documents used to validate the live wiring (see backend/README.md) are
`calibration` visits, so the number[detector]/number[laser] field types
(used only by the calibration templates — see seed_templates.py's
CST_CALIBRATION_FIELDS) have never actually been exercised, live or
otherwise. This at least proves the JSON-schema construction for those types
doesn't blow up; it can't prove the model fills them in correctly without a
real calibration document to test against.
"""
from __future__ import annotations

from app.seed_templates import CST_CALIBRATION_FIELDS
from app.services.extraction import _build_extract_tool, _leaf_json_schema


def test_number_detector_schema_is_an_object_of_numbers():
    assert _leaf_json_schema("number[detector]") == {"type": "object", "additionalProperties": {"type": "number"}}


def test_number_laser_schema_is_an_object_of_numbers():
    # Not used by any seeded template today (see seed_templates.py) but
    # handled identically to number[detector] — same detector-vs-laser split
    # the spec draws, just never actually populated by a real template yet.
    assert _leaf_json_schema("number[laser]") == {"type": "object", "additionalProperties": {"type": "number"}}


def test_calibration_template_builds_a_valid_tool_schema():
    tool = _build_extract_tool(CST_CALIBRATION_FIELDS)
    props = tool["input_schema"]["properties"]

    assert props["baseline_cv_percent"] == {"type": "object", "additionalProperties": {"type": "number"}}
    assert props["baseline_cv_percent__confidence"] == {"type": "number", "minimum": 0, "maximum": 1}
    assert props["laser_configuration"] == {"type": "array", "items": {"type": "string"}}
    assert "baseline_cv_percent" in tool["input_schema"]["required"]
    assert "baseline_cv_percent__confidence" in tool["input_schema"]["required"]
