"""Extraction service — §4 step 4.

`extract()` is the second function a real Claude vision call replaces (the
first is `classify()` in classification.py). Its contract — given an
attachment and its resolved template, return an `ExtractionResult`: the
template's field values, a confidence per field, and the date the service
visit took place — is what the rest of the app is built against; the live
path below (behind `settings.use_live_claude`) sends the attachment's PDF
plus the template's field list to Claude and parses back a value + confidence
per field via a forced tool call, same as classification.py.

The visit date isn't a template field: it's `Report.report_date`, a column
every report has whatever its template (the date filters, trend chart x-axis
and CSV export all key on it). It's read in the same call as the template's
fields, and its confidence is returned in `field_confidences` under the key
`report_date` — a name schemas.py reserves so no template field can collide
with it.

`source_snippet` (spec §4/§10) isn't threaded through to the return value
here — there's no `extraction_jobs` column to put it in yet (SL-TDD-001 §9
lists this as a known gap) — but the extraction prompt still enforces the
privacy design behind it: never pull contact, billing, or contract details
into a field's value, even when they sit right next to the relevant text.

The stub fabricates plausible values by field type/name so a review screen
built against this API has real-shaped data to render, and reproduces the
real repair document's content when it recognizes that sample file, matching
what's already shown in the repair-review-demo artifact.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import NamedTuple

from app.config import get_settings
from app.models import Attachment, ReportTemplate
from app.schemas import REPORT_DATE_KEY, TemplateFieldType
from app.services.claude_client import (
    is_sample_document as _is_sample_document,
    call_claude_tool,
    extract_tool_use,
    get_client as _get_client,
    stable_unit as _stable_unit,
)
from app.services.documents import UnsupportedDocumentError, claude_content_block
from app.services.errors import ExtractionError

logger = logging.getLogger("app.services.extraction")
settings = get_settings()

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
line".

Separately from the template's fields, also give `report_date`: the date this \
service visit was carried out, as YYYY-MM-DD. This is the one date the record \
itself needs — the privacy rule above is about keeping dates out of *field \
values*, not about this. On a BD Care Work Order Service Report, take it from the \
LABOR table's Start/End Date And Time — the day the engineer actually worked on the \
instrument (if labor spans several days, use the last End date). If there is no \
labor table, use the date printed beside the signatures. Never use the service \
contract start/end dates, the PO date, or any date in the CALIBRATED TOOLS table — \
those describe the contract and the engineer's test equipment, not this visit.

BD forms are not consistent about day/month order: some print dates month-first \
(02/10/2026 is 10 February 2026), others day-first (18/04/2021 is 18 April 2021). \
Every date on one form uses the same order, so work it out from this form: any date \
on the page with a part greater than 12 settles it (03/17/2025 can only be \
month-first). If nothing on the form settles it, give your best reading and a \
`report_date__confidence` of 0.5 or lower. If no visit date appears on the form, \
use an empty string with a low confidence."""

# A parsed visit date outside this window is treated as a misread (a dropped
# century digit, a next-service-due date picked up instead of the visit date)
# rather than stored: one bad year would stretch every trend chart for that
# instrument and drop the report out of any date-filtered view.
_EARLIEST_PLAUSIBLE_REPORT_DATE = date(1990, 1, 1)


class ExtractionResult(NamedTuple):
    extracted_fields: dict
    # One entry per template field, plus REPORT_DATE_KEY for report_date.
    field_confidences: dict
    # None when the document has no readable visit date.
    report_date: date | None


def _stub_value(field: dict, attachment_key: str):
    name, ftype = field["name"], field["type"]
    if ftype == TemplateFieldType.text:
        return f"[stub] {name.replace('_', ' ')} read from {attachment_key}"
    if ftype == TemplateFieldType.boolean:
        return _stable_unit(attachment_key, name) > 0.3
    if ftype == TemplateFieldType.date:
        return date.today().isoformat()
    if ftype == TemplateFieldType.number:
        return round(1 + _stable_unit(attachment_key, name) * 10, 1)
    if ftype in (TemplateFieldType.number_detector, TemplateFieldType.number_laser):
        axis = "detector" if ftype == TemplateFieldType.number_detector else "laser"
        return {f"{axis}_{i}": round(1 + _stable_unit(attachment_key, name, str(i)) * 5, 2) for i in range(1, 4)}
    if ftype == TemplateFieldType.enum:
        options = field.get("options") or ["unspecified"]
        return options[int(_stable_unit(attachment_key, name) * len(options))]
    if ftype == TemplateFieldType.enum_list:
        # e.g. "e.g. 405nm, 488nm, 640nm" -> ["405nm", "488nm", "640nm"]
        notes = field.get("notes") or ""
        if "e.g." in notes:
            return [v.strip() for v in notes.split("e.g.", 1)[1].split(",")]
        return []
    if ftype == TemplateFieldType.object_list:
        # A list of {name, type} columns, not a dict — see ItemSchemaColumn's
        # docstring (schemas.py) for why: Postgres's JSONB storage doesn't
        # preserve object key order, only array element order.
        item_schema = field.get("item_schema") or []
        return [{col["name"]: _stub_value(col, attachment_key) for col in item_schema}]
    return None


# ---------- live path: field-type -> JSON schema ----------


def _leaf_json_schema(ftype: str, options: list[str] | None = None) -> dict:
    if ftype == TemplateFieldType.text or ftype == TemplateFieldType.date:
        return {"type": "string"}
    if ftype == TemplateFieldType.number:
        return {"type": "number"}
    if ftype == TemplateFieldType.boolean:
        return {"type": "boolean"}
    if ftype == TemplateFieldType.enum:
        return {"type": "string", "enum": options or []}
    if ftype == TemplateFieldType.enum_list:
        return {"type": "array", "items": {"type": "string"}}
    if ftype in (TemplateFieldType.number_detector, TemplateFieldType.number_laser):
        return {"type": "object", "additionalProperties": {"type": "number"}}
    # Fallback for anything unanticipated — accept any JSON value rather than
    # failing the whole extraction over one odd field type.
    return {}


def _field_value_schema(field: dict) -> dict:
    ftype = field["type"]
    if ftype == TemplateFieldType.object_list:
        # See _stub_value above — item_schema is a list of {name, type}
        # columns, not a dict, so its order survives Postgres's JSONB
        # storage.
        item_schema = field.get("item_schema") or []
        return {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {col["name"]: _leaf_json_schema(col["type"]) for col in item_schema},
                "required": [col["name"] for col in item_schema],
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
    properties[REPORT_DATE_KEY] = {"type": "string", "description": "Service visit date, YYYY-MM-DD"}
    properties[_confidence_key(REPORT_DATE_KEY)] = {"type": "number", "minimum": 0, "maximum": 1}
    required.extend([REPORT_DATE_KEY, _confidence_key(REPORT_DATE_KEY)])
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
    names = {f["name"] for f in fields} | {REPORT_DATE_KEY}
    if names.isdisjoint(raw.keys()) and len(raw) == 1:
        inner = next(iter(raw.values()))
        if isinstance(inner, dict):
            return inner
    return raw


def _parse_report_date(value: object, attachment_path: str) -> date | None:
    """Claude's report_date answer → a date, or None when it's absent,
    unparseable, or implausible. Accepts a plain ISO date or an ISO
    datetime (the date part is used); anything else is logged and dropped
    rather than failing the whole extraction over one value."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        parsed = date.fromisoformat(text)
    except ValueError:
        try:
            parsed = datetime.fromisoformat(text).date()
        except ValueError:
            logger.warning("Unparseable report_date %r on attachment %s — leaving it unset", value, attachment_path)
            return None
    # One day of slack past today: the server's date can be a day behind
    # the technician's near midnight.
    if not (_EARLIEST_PLAUSIBLE_REPORT_DATE <= parsed <= date.today() + timedelta(days=1)):
        logger.warning("Implausible report_date %s on attachment %s — leaving it unset", parsed, attachment_path)
        return None
    return parsed


def _confidence_value(confidence: object, name: str, attachment_path: str) -> float:
    try:
        return float(confidence) if confidence is not None else 0.0
    except (TypeError, ValueError):
        # A non-numeric confidence shouldn't sink the whole extraction —
        # treat it as "couldn't tell," which is what a low confidence
        # already means to a reviewer, and keep the (possibly still useful)
        # value. Still worth a log line: this is Claude's tool call not
        # honoring its own schema, and it was previously invisible — the
        # field just silently showed up on the review screen flagged as
        # low-confidence with no trace of why.
        logger.warning(
            "Non-numeric confidence for field %r on attachment %s (got %r) — treating as 0.0",
            name,
            attachment_path,
            confidence,
        )
        return 0.0


def _live_extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    fields = template.field_schema.get("fields", [])
    try:
        document_block = claude_content_block(attachment.file_path)
    except UnsupportedDocumentError as e:
        raise ExtractionError(str(e)) from e
    tool = _build_extract_tool(fields)
    prompt = _EXTRACT_PROMPT_HEADER + "\n\nFields to extract:\n" + _field_list_for_prompt(fields)

    response = call_claude_tool(
        client=_get_client(),
        request_kwargs=dict(
            model=settings.anthropic_model,
            max_tokens=4096,
            tools=[tool],
            tool_choice={"type": "tool", "name": _EXTRACT_TOOL_NAME},
            messages=[
                {
                    "role": "user",
                    "content": [
                        document_block,
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
        ),
        error_cls=ExtractionError,
        logger=logger,
        attachment_path=attachment.file_path,
        verb="extract",
        gerund="extracting",
        noun="extraction",
    )

    tool_use = extract_tool_use(
        response,
        error_cls=ExtractionError,
        logger=logger,
        attachment_path=attachment.file_path,
        gerund="extracting",
        noun="extraction",
    )

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
        field_confidences[name] = _confidence_value(confidence, name, attachment.file_path)

    report_date = _parse_report_date(data.get(REPORT_DATE_KEY), attachment.file_path)
    field_confidences[REPORT_DATE_KEY] = (
        _confidence_value(data.get(_confidence_key(REPORT_DATE_KEY)), REPORT_DATE_KEY, attachment.file_path)
        if report_date is not None
        else 0.0
    )
    return ExtractionResult(extracted_fields, field_confidences, report_date)


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


def _stub_extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    fields = template.field_schema.get("fields", [])
    is_sample = _is_sample_document(attachment.file_path)

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

    # A stable date within the past year — not a value read from any real
    # document, just so the date filters and trend chart have something to
    # work with in stub mode.
    report_date = date.today() - timedelta(days=int(_stable_unit(attachment.file_path, REPORT_DATE_KEY) * 365))
    field_confidences[REPORT_DATE_KEY] = round(
        0.55 + _stable_unit(attachment.file_path, REPORT_DATE_KEY, "conf") * 0.44, 2
    )
    return ExtractionResult(extracted_fields, field_confidences, report_date)


def extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    if settings.use_live_claude:
        return _live_extract(attachment, template)
    return _stub_extract(attachment, template)
