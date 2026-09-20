"""Extraction service — §4 step 4.

`extract()` is the second function a real Claude vision call replaces (the
first is `classify()` in classification.py). Its contract — given an
attachment and its resolved template, return `(extracted_fields,
field_confidences)` — is what the rest of the app is built against; the live
path below (behind `settings.use_live_claude`) sends the attachment's PDF
plus the template's field list to Claude and parses back a value + confidence
per field via a forced tool call, same as classification.py.

`source_snippet` (spec §4/§10) isn't threaded through to the return value
here — there's no `extraction_jobs` column to put it in yet (CL-TDD-001 §9
lists this as a known gap) — but the extraction prompt still enforces the
privacy design behind it: never pull contact, billing, or contract details
into a field's value, even when they sit right next to the relevant text.

The stub fabricates plausible values by field type/name so a review screen
built against this API has real-shaped data to render, and reproduces the
real repair document's content when it recognizes that sample file, matching
what's already shown in the repair-review-demo artifact.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import time
from datetime import date
from pathlib import Path

import anthropic
from anthropic import Anthropic

from app.config import get_settings
from app.models import Attachment, ReportTemplate
from app.services.errors import ExtractionError

logger = logging.getLogger("app.services.extraction")
settings = get_settings()

_SAMPLE_MARKERS = ("wo-04587090", "sample", "work_order", "work-order")

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(
            api_key=settings.anthropic_api_key,
            timeout=settings.anthropic_timeout_seconds,
            max_retries=settings.anthropic_max_retries,
        )
    return _client


_EXTRACT_TOOL_NAME = "record_extraction"

_EXTRACT_PROMPT_HEADER = """This is a scanned BD Care service report. Extract exactly the fields listed \
in the tool schema below, and only those fields — nothing else on the page.

For each field, give:
- `value`: read directly from the document. If the field's content genuinely isn't \
present on the form, use an empty string ("" for text, [] for lists, or the type's \
natural empty value) rather than inventing something, and give it a low confidence.
- `confidence`: 0 to 1, reflecting how sure you actually are — a clean, unambiguous, \
directly-printed value deserves 0.85+; anything inferred, illegible, or genuinely \
absent from the form deserves meaningfully lower. Don't default to a high number.

Privacy — this is not optional: never let the customer's name, account, address, \
phone number, contract number, or any other contact/billing detail enter a field's \
value, even in a text field, even when that detail sits on the same line or right \
next to text you do need. This also covers the engineer/technician's own name and \
the date they signed or logged an entry — quote logs are often written as \
"<note>. By <name> on <date>", and that attribution is not part of the fault, work, \
or note content any field is asking for. Crop tightly to only the content the field \
actually asks for. For example, a Subject line reading "11 Month Recurring / \
SMX0457374" contains a contract number after the slash — extract only "11 Month \
Recurring". Likewise a quote reading "Air bubble in bleach line. By Shachar on \
18/04/2021" contains a technician sign-off — extract only "Air bubble in bleach \
line"."""


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


# ---------- live path: field-type -> JSON schema ----------


def _leaf_json_schema(ftype: str, options: list[str] | None = None) -> dict:
    if ftype == "text" or ftype == "date":
        return {"type": "string"}
    if ftype == "number":
        return {"type": "number"}
    if ftype == "boolean":
        return {"type": "boolean"}
    if ftype == "enum":
        return {"type": "string", "enum": options or []}
    if ftype == "enum[]":
        return {"type": "array", "items": {"type": "string"}}
    if ftype in ("number[detector]", "number[laser]"):
        return {"type": "object", "additionalProperties": {"type": "number"}}
    # Fallback for anything unanticipated — accept any JSON value rather than
    # failing the whole extraction over one odd field type.
    return {}


def _field_value_schema(field: dict) -> dict:
    ftype = field["type"]
    if ftype == "object[]":
        item_schema = field.get("item_schema", {})
        return {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {k: _leaf_json_schema(v) for k, v in item_schema.items()},
                "required": list(item_schema.keys()),
            },
        }
    return _leaf_json_schema(ftype, field.get("options"))


def _confidence_key(name: str) -> str:
    return f"{name}__confidence"


def _build_extract_tool(fields: list[dict]) -> dict:
    # Flat top-level properties (name -> value, name__confidence -> number)
    # rather than nesting {value, confidence} under each field name. A live
    # trial run showed the model reliably fills in flat, directly-typed
    # top-level properties (this is exactly the shape classification.py's
    # tool already uses successfully) but collapses a nested per-field
    # object into a stringified value and drops confidence entirely —
    # apparently a real weak spot in how tool-use schemas of that shape get
    # honored. Flattening fixed it in practice; keep it flat.
    properties = {}
    required = []
    for field in fields:
        name = field["name"]
        properties[name] = _field_value_schema(field)
        conf_key = _confidence_key(name)
        properties[conf_key] = {"type": "number", "minimum": 0, "maximum": 1}
        required.extend([name, conf_key])
    return {
        "name": _EXTRACT_TOOL_NAME,
        "description": "Record the extracted value and confidence for every field of this report template.",
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required,
        },
    }


def _field_list_for_prompt(fields: list[dict]) -> str:
    lines = []
    for field in fields:
        unit = f", unit: {field['unit']}" if field.get("unit") else ""
        notes = f" — {field['notes']}" if field.get("notes") else ""
        lines.append(f"- {field['name']} ({field['type']}{unit}){notes}")
    return "\n".join(lines)


def _resolve_extraction_data(raw: dict, fields: list[dict]) -> dict:
    """Defensive unwrap for the whole answer. The schema asks for flat
    top-level fields (name -> value, name__confidence -> number — see
    _build_extract_tool), but a live run showed the model sometimes wraps
    its entire answer under one extra key instead (e.g. `{"value": {...all
    fields...}}`) rather than answering at the top level. Tool-use input
    isn't strictly validated against the schema, so if none of the expected
    field names appear at the top level and there's exactly one key, try
    unwrapping it once before giving up on the expected shape."""
    names = {f["name"] for f in fields}
    if names.isdisjoint(raw.keys()) and len(raw) == 1:
        inner = next(iter(raw.values()))
        if isinstance(inner, dict):
            return inner
    return raw


def _live_extract(attachment: Attachment, template: ReportTemplate) -> tuple[dict, dict]:
    fields = template.field_schema.get("fields", [])
    pdf_bytes = Path(attachment.file_path).read_bytes()
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
    tool = _build_extract_tool(fields)
    prompt = _EXTRACT_PROMPT_HEADER + "\n\nFields to extract:\n" + _field_list_for_prompt(fields)

    # See the matching comment in classification.py — no APM/request tracing
    # in this project, so this timer is the only record of how long a live
    # Claude call actually took, on both the success and failure path.
    call_started = time.perf_counter()
    try:
        response = _get_client().messages.create(
            model=settings.anthropic_model,
            max_tokens=4096,
            tools=[tool],
            tool_choice={"type": "tool", "name": _EXTRACT_TOOL_NAME},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        )
    except anthropic.AuthenticationError as e:
        # Logged here (not just raised) because the router/worker only ever
        # store str(e) on the job row — without this, an auth failure was
        # previously invisible anywhere a human would actually look while
        # debugging live (see the matching comment in classification.py).
        logger.exception(
            "Claude API authentication failed extracting attachment %s after %.2fs",
            attachment.file_path,
            time.perf_counter() - call_started,
        )
        raise ExtractionError(f"Claude API authentication failed — check ANTHROPIC_API_KEY: {e}") from e
    except anthropic.APIError as e:
        logger.exception(
            "Claude API request failed extracting attachment %s after %.2fs",
            attachment.file_path,
            time.perf_counter() - call_started,
        )
        raise ExtractionError(f"Claude API request failed during extraction: {e}") from e

    usage = getattr(response, "usage", None)
    logger.info(
        "Claude extract API call for attachment %s completed in %.2fs (input_tokens=%s, output_tokens=%s)",
        attachment.file_path,
        time.perf_counter() - call_started,
        getattr(usage, "input_tokens", "?"),
        getattr(usage, "output_tokens", "?"),
    )

    try:
        tool_use = next(block for block in response.content if block.type == "tool_use")
    except StopIteration as e:
        logger.error(
            "Claude returned no tool_use block extracting attachment %s (got block types: %s)",
            attachment.file_path,
            [getattr(block, "type", "?") for block in response.content],
        )
        raise ExtractionError(
            "Claude did not return the expected tool call for extraction (no tool_use block in the response)"
        ) from e

    data = _resolve_extraction_data(tool_use.input, fields)

    extracted_fields: dict = {}
    field_confidences: dict = {}
    for field in fields:
        name = field["name"]
        value = data.get(name)
        confidence = data.get(_confidence_key(name))
        # Extra defensive unwrap: even with a flat schema, a live run showed
        # the model occasionally answers one field as {"value":...,
        # "confidence":...} anyway (the exact nested shape a first draft of
        # this schema used, and apparently still a shape the model reaches
        # for on its own sometimes). Tool-use input isn't strictly validated
        # against the schema, so recover either shape rather than trusting
        # only the one the schema asks for.
        if isinstance(value, dict) and "value" in value:
            confidence = value.get("confidence", confidence)
            value = value.get("value")
        extracted_fields[name] = value
        try:
            field_confidences[name] = float(confidence) if confidence is not None else 0.0
        except (TypeError, ValueError):
            # A non-numeric confidence shouldn't sink the whole extraction —
            # treat it as "couldn't tell," which is what a low confidence
            # already means to a reviewer, and keep the (possibly still
            # useful) value. Still worth a log line: this is Claude's tool
            # call not honoring its own schema, and it was previously
            # invisible — the field just silently showed up on the review
            # screen flagged as low-confidence with no trace of why.
            logger.warning(
                "Non-numeric confidence for field %r on attachment %s (got %r) — treating as 0.0",
                name,
                attachment.file_path,
                confidence,
            )
            field_confidences[name] = 0.0
    return extracted_fields, field_confidences


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


def _stub_extract(attachment: Attachment, template: ReportTemplate) -> tuple[dict, dict]:
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


def extract(attachment: Attachment, template: ReportTemplate) -> tuple[dict, dict]:
    if settings.use_live_claude:
        return _live_extract(attachment, template)
    return _stub_extract(attachment, template)
