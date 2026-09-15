"""Extraction service — §4 step 4.

`extract()` is the second function a real Claude vision call replaces later
(the first is `classify()` in classification.py). Its contract — given an
attachment and its resolved template, return `(extracted_fields,
field_confidences)` — is what the rest of the app is built against; a real
implementation sends the attachment's pages plus the template's field list to
Claude and parses back `{value, confidence, source_snippet}` per field (§4).
`source_snippet` isn't modeled yet in the stub since nothing here reads a
real document — see the spec §4/§10 for why it has to stay tightly cropped
once this is live.

The stub fabricates plausible values by field type/name so a review screen
built against this API has real-shaped data to render, and reproduces the
real repair document's content when it recognizes that sample file, matching
what's already shown in the repair-review-demo artifact.
"""
from __future__ import annotations

import hashlib
from datetime import date

from app.models import Attachment, ReportTemplate

_SAMPLE_MARKERS = ("wo-04587090", "sample", "work_order", "work-order")

# Real values from the BD Care EU Work Order Service Report used throughout
# the spec (Case 03191457 / WO-04587090, LSRFortessa S/N R647794E6092),
# already surfaced in repair-review-demo.html.
_SAMPLE_REPAIR_VALUES = {
    "fault_description": "No see events",
    "root_cause": "",
    "work_performed": (
        "Inspected fluidics path, replaced sample injector O-ring, primed and ran QC beads. "
        "System now sees events normally."
    ),
    "components_replaced": [],
    "labor_hours": 11.5,
    "fault_category": "fluidics",
    "retest_result": "pass",
}


def _stable_unit(*parts: str) -> float:
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def _stub_value(field: dict, attachment_key: str):
    name, ftype = field["name"], field["type"]
    if ftype == "text":
        return f"[stub] {name.replace('_', ' ')} read from {attachment_key}"
    if ftype == "boolean":
        return _stable_unit(attachment_key, name) > 0.3
    if ftype == "date":
        return date.today().isoformat()
    if ftype == "number":
        return round(1 + _stable_unit(attachment_key, name) * 10, 1)
    if ftype in ("number[detector]", "number[laser]"):
        axis = "detector" if ftype == "number[detector]" else "laser"
        return {f"{axis}_{i}": round(1 + _stable_unit(attachment_key, name, str(i)) * 5, 2) for i in range(1, 4)}
    if ftype == "enum":
        options = field.get("options") or ["unspecified"]
        return options[int(_stable_unit(attachment_key, name) * len(options))]
    if ftype == "enum[]":
        # e.g. "e.g. 405nm, 488nm, 640nm" -> ["405nm", "488nm", "640nm"]
        notes = field.get("notes") or ""
        if "e.g." in notes:
            return [v.strip() for v in notes.split("e.g.", 1)[1].split(",")]
        return []
    if ftype == "object[]":
        item_schema = field.get("item_schema", {})
        return [{k: _stub_value({"name": k, "type": v}, attachment_key) for k, v in item_schema.items()}]
    return None


def extract(attachment: Attachment, template: ReportTemplate) -> tuple[dict, dict]:
    fields = template.field_schema.get("fields", [])
    lower_path = attachment.file_path.lower()
    is_sample = any(marker in lower_path for marker in _SAMPLE_MARKERS)

    extracted_fields: dict = {}
    field_confidences: dict = {}
    for field in fields:
        name = field["name"]
        if is_sample and name in _SAMPLE_REPAIR_VALUES:
            extracted_fields[name] = _SAMPLE_REPAIR_VALUES[name]
            # root_cause and components_replaced are genuinely blank on the
            # real document (§5) — low confidence reflects "couldn't find
            # this," not a bad read, and both get flagged for review.
            field_confidences[name] = 0.35 if name in ("root_cause", "components_replaced") else 0.9
        else:
            extracted_fields[name] = _stub_value(field, attachment.file_path)
            field_confidences[name] = round(0.55 + _stable_unit(attachment.file_path, name, "conf") * 0.44, 2)

    return extracted_fields, field_confidences
