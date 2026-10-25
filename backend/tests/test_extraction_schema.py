"""Schema-shape tests for extract()'s live-path tool schema builder.

These don't call the Claude API (conftest.py forces USE_LIVE_CLAUDE=false for
the whole suite). They prove the JSON-schema construction for the
number[detector]/number[laser] field types (no seeded template uses them any
more; custom templates can) doesn't blow up.
"""
from __future__ import annotations

from app.services.extraction import _build_extract_tool, _leaf_json_schema


def test_number_detector_schema_is_an_object_of_numbers():
    assert _leaf_json_schema("number[detector]") == {"type": "object", "additionalProperties": {"type": "number"}}


def test_number_laser_schema_is_an_object_of_numbers():
    # Not used by any seeded template but
    # handled identically to number[detector] — same detector-vs-laser split
    # the spec draws, just never actually populated by a real template yet.
    assert _leaf_json_schema("number[laser]") == {"type": "object", "additionalProperties": {"type": "number"}}


def test_per_detector_template_builds_a_valid_tool_schema():
    fields = [
        {"name": "laser_configuration", "type": "enum[]", "unit": None, "notes": None, "options": ["405nm", "488nm"]},
        {"name": "baseline_cv_percent", "type": "number[detector]", "unit": "%", "notes": None},
    ]
    tool = _build_extract_tool(fields)
    props = tool["input_schema"]["properties"]

    assert props["baseline_cv_percent"] == {"type": "object", "additionalProperties": {"type": "number"}}
    assert props["baseline_cv_percent__confidence"] == {"type": "number", "minimum": 0, "maximum": 1}
    assert props["laser_configuration"] == {"type": "array", "items": {"type": "string"}}
    assert "baseline_cv_percent" in tool["input_schema"]["required"]
    assert "baseline_cv_percent__confidence" in tool["input_schema"]["required"]
