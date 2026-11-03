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
from app.services.attachment_names import source_name
from app.services.claude_client import (
    is_sample_document as _is_sample_document,
    call_claude_tool,
    extract_tool_use,
    raise_if_truncated,
    get_client as _get_client,
    stable_unit as _stable_unit,
)
from app.services.documents import UnsupportedDocumentError
from app.services.translation import source_block
from app.services.errors import ExtractionError
from app.services.field_values import normalize_values
from app.services.privacy import scrub_values
from app.services.text_extraction import text_extract
from app.services.extraction_prompt import (  # noqa: F401  (moved; re-exported here)
    _EXTRACT_TOOL_NAME,
    _EXTRACT_PROMPT_HEADER,
    _leaf_json_schema,
    _field_value_schema,
    _confidence_key,
    _build_extract_tool,
    _field_list_for_prompt,
    _box_key,
    _BOX_PROMPT,
)

logger = logging.getLogger("app.services.extraction")
settings = get_settings()


# A field the privacy check had to change is at most this sure (below the review threshold).
_SCRUBBED_CONFIDENCE = 0.5


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
    # Where the model says it read each value: {field name: {page, x, y, w, h}} as page fractions. Only asked
    # of a scan or photo (a PDF with a text layer is searched instead), so None for anything else.
    field_boxes: dict | None = None


def _wants_boxes(attachment: Attachment, document_block: dict) -> bool:
    """Boxes are asked for when the model reads the picture itself and nothing can find the values afterwards:
    an image, or a PDF with no text layer. Not for a reviewed translation (its text is not on the page)."""
    if document_block.get("type") == "text":
        return False
    if getattr(attachment, "file_type", None) != "application/pdf":
        return True
    try:
        from app.services.page_text import page_words

        return not page_words(attachment.file_path, 1)[1]
    except Exception:  # an unreadable file fails later with a proper error; asking for boxes is harmless
        return True


def _parse_box(raw: object) -> dict | None:
    """One `<field>__box` answer → {page, x, y, w, h}, or None when it is missing or not a usable box. The
    model's tool input is not validated, so be strict here: numbers only, inside the page, with some size."""
    if not isinstance(raw, dict):
        return None
    try:
        page = int(raw["page"])
        x, y, w, h = (float(raw[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if page < 1 or not all(0 <= v <= 1 for v in (x, y, w, h)) or w <= 0 or h <= 0:
        return None
    w, h = min(w, 1 - x), min(h, 1 - y)
    if w <= 0 or h <= 0:
        return None
    return {"page": page, "x": x, "y": y, "w": w, "h": h}


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
        options = field.get("options") or []
        if options:
            return [options[int(_stable_unit(attachment_key, name) * len(options))]]
        return []
    if ftype == TemplateFieldType.object_list:
        # A list of {name, type} columns, not a dict — see ItemSchemaColumn's
        # docstring (schemas.py) for why: Postgres's JSONB storage doesn't
        # preserve object key order, only array element order.
        item_schema = field.get("item_schema") or []
        return [{col["name"]: _stub_value(col, attachment_key) for col in item_schema}]
    return None


# ---------- live path: field-type -> JSON schema ----------


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
        document_block = source_block(attachment)
    except UnsupportedDocumentError as e:
        raise ExtractionError(str(e)) from e
    with_boxes = _wants_boxes(attachment, document_block)
    tool = _build_extract_tool(fields, with_boxes)
    prompt = _EXTRACT_PROMPT_HEADER + "\n\nFields to extract:\n" + _field_list_for_prompt(fields)
    if with_boxes:
        prompt += _BOX_PROMPT

    response = call_claude_tool(
        client=_get_client(),
        request_kwargs=dict(
            model=settings.anthropic_model,
            max_tokens=settings.extract_max_tokens,
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

    raise_if_truncated(response, error_cls=ExtractionError, noun="extraction")
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
    field_boxes: dict = {}
    for field in fields:
        name = field["name"]
        value = data.get(name)
        if with_boxes:
            box = _parse_box(data.get(_box_key(name)))
            if box is not None:
                field_boxes[name] = box
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
    if with_boxes:
        box = _parse_box(data.get(_box_key(REPORT_DATE_KEY)))
        if box is not None and report_date is not None:
            field_boxes[REPORT_DATE_KEY] = box
    return ExtractionResult(extracted_fields, field_confidences, report_date, field_boxes if with_boxes else None)


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
    "fault_category": ["fluidics"],
}


def _stub_extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    fields = template.field_schema.get("fields", [])
    is_sample = _is_sample_document(source_name(attachment))

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


def _text_layer_extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    """Stub mode with STUB_EXTRACT_FROM_TEXT: the template's fields read from
    the PDF's own text (services/text_extraction.py), nothing invented."""
    try:
        with open(attachment.file_path, "rb") as f:
            data = f.read()
    except OSError as e:
        raise ExtractionError(f"The stored file could not be read: {e}") from e
    fields = template.field_schema.get("fields", [])
    extracted_fields, field_confidences, report_date = text_extract(data, fields)
    return ExtractionResult(extracted_fields, field_confidences, report_date)


def extract(attachment: Attachment, template: ReportTemplate) -> ExtractionResult:
    if settings.use_live_claude:
        result = _live_extract(attachment, template)
    elif settings.stub_extract_from_text:
        result = _text_layer_extract(attachment, template)
    else:
        result = _stub_extract(attachment, template)
    fields = template.field_schema.get("fields", [])
    values = normalize_values(fields, result.extracted_fields)
    # The privacy rule's safety net: anything it removes leaves the field doubtful, so a person looks.
    values, scrubbed = scrub_values(fields, values)
    confidences = {
        k: (min(v, _SCRUBBED_CONFIDENCE) if k in scrubbed and isinstance(v, (int, float)) else v)
        for k, v in result.field_confidences.items()
    }
    if scrubbed:
        logger.info("Privacy check removed names or contract details from: %s", ", ".join(sorted(scrubbed)))
    return result._replace(extracted_fields=values, field_confidences=confidences)
