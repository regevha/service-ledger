"""The extraction prompt and the JSON-schema builders for the forced tool call (re-exported by extraction.py)."""
from __future__ import annotations
from datetime import date

from app.schemas import REPORT_DATE_KEY, TemplateFieldType


_EXTRACT_TOOL_NAME = "record_extraction"


_EXTRACT_PROMPT_HEADER = """This is a scanned service report (the notes below about dates and sign-offs are written for BD Care Work Order Service Reports; on another maker's report use the equivalent fields). Extract exactly the fields listed \
below under "Fields to extract", and only those fields — nothing else on the page.

The tool takes a flat answer: for each field, one entry named exactly like the field, \
and a second entry named like the field plus "__confidence" (for example `labor_hours` \
and `labor_hours__confidence`). Do not nest the value and the confidence together under \
one key, and do not wrap the whole answer under another key.
- `<field>`: read directly from the document. If the field's content genuinely isn't \
present on the form, use an empty string ("" for text, [] for lists, or the type's \
natural empty value) rather than inventing something, and give it a low confidence.
- `<field>__confidence`: 0 to 1, reflecting how sure you actually are — a clean, unambiguous, \
directly-printed value deserves 0.85+; anything inferred, illegible, or genuinely \
absent from the form deserves meaningfully lower. Don't default to a high number.

Privacy — this is not optional: no person's name and no contract detail may appear in any field, free text included; \
write "the engineer" or "the customer" instead of a name. Never let the customer's name, account, address, \
phone number, contract number, or any other contact/billing detail enter a field's \
value, even in a text field, even when that detail sits on the same line or right \
next to text you do need. This also covers the engineer/technician's own name and \
the date they signed or logged an entry — quote logs are often written as \
"<note>. By <name> on <date>", and that attribution is not part of the fault, work, \
or note content any field is asking for. Crop tightly to only the content the field \
actually asks for. For example, a Subject line reading "11 Month Recurring / \
SMX0000001" contains a contract number after the slash — extract only "11 Month \
Recurring". Likewise a quote reading "Air bubble in bleach line. By A. Engineer on \
18/04/2021" contains a technician sign-off — extract only "Air bubble in bleach \
line".

Serial numbers: the Subject and Description lines are typed by hand and can carry a \
serial with a typo (for example "S/N R1000000000042" on a form whose Installed Product \
box shows MP1000000000042). The instrument's serial is stored separately, so do not copy \
a serial number or an "S/N ..." phrase from those lines into a field's value; describe \
what was done without it.

Separately from the template's fields, also give `report_date`: the date this \
service visit was carried out, as YYYY-MM-DD. This is the one date the record \
itself needs — the privacy rule above is about keeping dates out of *field \
values*, not about this. On a BD Care Work Order Service Report, take it from the \
LABOR table's Start/End Date And Time — the day the engineer actually worked on the \
instrument (if labor spans several days, use the last End date). If there is no \
labor table, use the date printed beside the signatures. Never use the service \
contract start/end dates, the PO date, or any date in the CALIBRATED TOOLS table — \
those describe the contract and the engineer's test equipment, not this visit.

Durations: a time printed as a clock duration (HH:MM, for example 01:25) is hours and \
minutes, not decimal hours; give a numeric hours field as decimal hours rounded to the nearest quarter hour (01:25 is 1.5). \
A number with no unit printed on a labour or work line is hours. Never invent a unit for a \
value that has none. If the document is a reviewed English translation of a Hebrew form, \
identifiers and dates in it are exactly as printed on the original.

Forms are not consistent about day/month order (BD ones, for example): some print dates month-first \
(02/10/2026 is 10 February 2026), others day-first (18/04/2021 is 18 April 2021). \
Every date on one form uses the same order, so work it out from this form: any date \
on the page with a part greater than 12 settles it (03/17/2025 can only be \
month-first). If nothing on the form settles it, give your best reading and a \
`report_date__confidence` of 0.5 or lower. If no visit date appears on the form, \
use an empty string with a low confidence."""


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
        items = {"type": "string", "enum": options} if options else {"type": "string"}
        return {"type": "array", "items": items}
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


def _box_key(name: str) -> str:
    return f"{name}__box"


_BOX_SCHEMA = {
    "type": "object",
    "description": "Where on the page the value was read: page (1-based) and a box as fractions of the page from the top left.",
    "properties": {
        "page": {"type": "integer", "minimum": 1},
        "x": {"type": "number", "minimum": 0, "maximum": 1},
        "y": {"type": "number", "minimum": 0, "maximum": 1},
        "w": {"type": "number", "minimum": 0, "maximum": 1},
        "h": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["page", "x", "y", "w", "h"],
}

# Added to the prompt only when boxes are asked for (a scan or photo, which has no text layer to search).
_BOX_PROMPT = """

Positions: for each field you found on the page, also give `<field>__box` (for example `labor_hours__box`): the page \
number (1 for a single image) and a tight box around the printed value you read, as fractions of the page measured \
from its top left corner (x and y are the box's top left corner; w and h its width and height; all between 0 and 1). \
Box the value itself, not the label. Leave the box out for a field that is not on the page."""


def _build_extract_tool(fields: list[dict], with_boxes: bool = False) -> dict:
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
        if with_boxes:
            # Optional: a missing box just means no position for that field.
            properties[_box_key(name)] = _BOX_SCHEMA
    properties[REPORT_DATE_KEY] = {"type": "string", "description": "Service visit date, YYYY-MM-DD"}
    properties[_confidence_key(REPORT_DATE_KEY)] = {"type": "number", "minimum": 0, "maximum": 1}
    if with_boxes:
        properties[_box_key(REPORT_DATE_KEY)] = _BOX_SCHEMA
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
        if field.get("optional"):
            notes += " (optional: if the form does not state it, answer with an empty value, not a guess)"
        lines.append(f"- {field['name']} ({field['type']}{unit}){notes}")
    return "\n".join(lines)
