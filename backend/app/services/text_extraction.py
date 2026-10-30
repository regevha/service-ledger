"""Reading a template's fields from a BD service report's own text, no model.

Stub mode used to invent a plausible value for every field. This module is the
option that reads the real document instead (setting `stub_extract_from_text`,
env STUB_EXTRACT_FROM_TEXT). It understands the BD Care Work Order Service
Report layout, whose sections have fixed headings:

    SERVICE REQUESTED / REPORTED SYMPTOM   Subject and Description lines
    CAUSE
    WORK PERFORMED / SOLUTION COMMENTS
    PARTS USED
    LABOR / TRAVEL / EXPENSE
    CALIBRATED TOOLS

and returns the same `ExtractionResult` shape as the live path. The rule that
shapes everything here: **a field is filled only with what was read.** A field
this module has no rule for (the lab-manager's fault category, a verification
result, anything on another maker's form) stays empty with confidence 0, so the
review screen flags it instead of showing an invented value.

Confidence is a fixed number per kind of read, not a measurement: 0.9 for text
copied from under its heading, 0.8 for a value computed from a table, 0.35 for
a section that is present but empty. The visit date follows the live prompt's
rule for day/month order (see `date_order`).

pypdf joins a label to the value beside it, so every pattern anchors on the
section headings, which sit on their own lines.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Literal

from app.schemas import REPORT_DATE_KEY, TemplateFieldType
from app.services.errors import ExtractionError
from app.services.text_reader import extract_text

logger = logging.getLogger("app.services.text_extraction")

# Reading every page: the narrative and the tables can run past page 3 (the
# identification reader stops there on purpose).
MAX_PAGES = 20

CONF_READ = 0.9  # text copied from under its heading
CONF_COMPUTED = 0.8  # worked out from a table (labor hours)
CONF_EMPTY_SECTION = 0.35  # the heading is there, nothing is written under it
CONF_DATE_UNSETTLED = 0.5  # day/month order could not be settled from the form

_EARLIEST_PLAUSIBLE = date(1990, 1, 1)

_DATE = r"\d{1,2}/\d{1,2}/\d{4}"
_TIME = r"\d{1,2}:\d{2}(?: [AP]M)?"


def _section(text: str, start: str, end: str) -> str | None:
    """The text between two headings, or None when the start heading is absent."""
    # ^ in MULTILINE mode also matches right after the newline the start
    # heading consumed, so a heading followed at once by the next one is an
    # empty section rather than one that runs to the end of the document.
    match = re.search(r"^[ \t]*" + start + r"[ \t]*\n(.*?)(?:^[ \t]*" + end + r"|\Z)", text, re.S | re.M)
    return match.group(1).strip() if match else None


def date_order(text: str) -> Literal["day-first", "month-first"] | None:
    """Whether the form prints dates day-first or month-first. Every date on one
    form uses the same order, so any date with a part above 12 settles it
    (03/17/2025 can only be month-first). None when nothing settles it."""
    for first, second in re.findall(r"\b(\d{1,2})/(\d{1,2})/\d{4}\b", text):
        if int(first) > 12:
            return "day-first"
        if int(second) > 12:
            return "month-first"
    return None


def _to_date(value: str, order: str | None) -> date | None:
    first, second, year = (int(p) for p in value.split("/"))
    # An unsettled order is read day-first: BD's EU work orders mostly are.
    day, month = (second, first) if order == "month-first" else (first, second)
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _heading_line(text: str, label: str) -> str | None:
    """The value of a ": <value><label>" line. pypdf prints the label after
    the value ("...nozzles" + "Subject"), so the value is what precedes it."""
    match = re.search(r"^:[ \t]*(.*?)[ \t]*" + label + r"[ \t]*$", text, re.M)
    return match.group(1).strip() if match else None


def _clean_line(value: str) -> str:
    """Keep the contract and serial out of a Subject or Description line, as the
    live prompt does: "11 Month Recurring / SMX0457374" -> "11 Month Recurring",
    "Stream is unstable - ARIA III S/N P648282B3003" -> "Stream is unstable"."""
    value = re.sub(r"\s*-?\s*[A-Za-z0-9 ]*S/N\s+\S+$", "", value)
    value = re.sub(r"\s*/\s*SMX\d+$", "", value)
    return value.strip(" -")


def read_description(text: str) -> str | None:
    """Subject and Description joined, once when they are identical."""
    subject = _heading_line(text, "Subject")
    description = _heading_line(text, "Description")
    parts = [_clean_line(p) for p in (subject, description) if p]
    parts = [p for i, p in enumerate(parts) if p and p not in parts[:i]]
    return " ".join(parts) or None


def read_parts(text: str) -> list[dict] | None:
    """The PARTS USED rows as part name, part number and quantity. None when the
    section is missing, [] when it holds no rows."""
    block = _section(text, r"PARTS USED", r"LABOR")
    if block is None:
        return None
    rows = []
    body = re.sub(r"Part In Part Number Line Qty\s*", "", block)
    # Two layouts: the name, then the part-in location and number on the next
    # line ("644651 - Sample/Sheath Regulator Assembly" / "V-Pos 644651 1"), or
    # all on one line ("667009 - S8 PM kit 667009 1"). The location word counts
    # only at the start of that next line, so a name's own last word ("kit")
    # is never taken for it.
    pattern = re.compile(r"^(\d{5,}) - ([^\n]+?)(?:\n[A-Za-z][\w-]*)?[ \t\n]+(\d{5,}) (\d+)[ \t]*$", re.M)
    for match in pattern.finditer(body):
        rows.append({"part_name": match.group(2).strip(), "part_number": match.group(3), "qty": int(match.group(4))})
    return rows


def read_labor(text: str, order: str | None) -> tuple[float, date | None] | None:
    """(total rounded hours, last end date) from the LABOR table, or None when
    the table has no rows. Travel is a separate table and is not counted."""
    block = _section(text, r"LABOR", r"TRAVEL")
    if not block:
        return None
    block = re.sub(r"\n(?=minute\(s\))", " ", block)
    row = re.compile(
        rf"({_DATE}) {_TIME} ({_DATE}) {_TIME} .*?minute\(s\)\s*(\d+(?:\.\d+)?)", re.S
    )
    rows = row.findall(block)
    if not rows:
        return None
    hours = sum(float(r[2]) for r in rows)
    ends = [d for d in (_to_date(r[1], order) for r in rows) if d is not None]
    return hours, (max(ends) if ends else None)


def _empty_value(field: dict):
    """The type's natural empty value, as the live prompt asks for."""
    ftype = field["type"]
    if ftype == TemplateFieldType.text:
        return ""
    if ftype in (TemplateFieldType.enum_list, TemplateFieldType.object_list):
        return []
    if ftype in (TemplateFieldType.number_detector, TemplateFieldType.number_laser):
        return {}
    return None


def extract_from_text(text: str, fields: list[dict]):
    """Fill `fields` from `text`. Returns (extracted_fields, field_confidences,
    report_date); the caller wraps them in an ExtractionResult."""
    order = date_order(text)
    labor = read_labor(text, order)
    description = read_description(text)
    cause = _section(text, r"CAUSE", r"WORK PERFORMED / SOLUTION COMMENTS")
    work = _section(text, r"WORK PERFORMED / SOLUTION COMMENTS", r"PARTS USED")
    parts = read_parts(text)

    def text_read(value: str | None):
        if value is None:
            return "", 0.0
        return value, (CONF_READ if value else CONF_EMPTY_SECTION)

    def list_read(rows: list[dict] | None):
        if rows is None:
            return [], 0.0
        return rows, (CONF_READ if rows else CONF_EMPTY_SECTION)

    readers = {
        "fault_description": lambda: text_read(description),
        "service_description": lambda: text_read(description),
        "root_cause": lambda: text_read(cause),
        "work_performed": lambda: text_read(work),
        "components_replaced": lambda: list_read(parts),
        "labor_hours": lambda: (labor[0], CONF_COMPUTED) if labor else (None, 0.0),
    }

    extracted: dict = {}
    confidences: dict = {}
    for field in fields:
        name = field["name"]
        reader = readers.get(name)
        # A rule applies only when the field has the type the rule produces; a
        # custom template that reuses the name for another type is left empty.
        expected = {
            "components_replaced": TemplateFieldType.object_list,
            "labor_hours": TemplateFieldType.number,
        }.get(name, TemplateFieldType.text)
        if reader is None or field["type"] != expected:
            extracted[name], confidences[name] = _empty_value(field), 0.0
            continue
        extracted[name], confidences[name] = reader()

    report_date = labor[1] if labor else None
    if report_date is not None and not (_EARLIEST_PLAUSIBLE <= report_date <= date.today()):
        logger.warning("Implausible visit date %s read from the labor table — leaving it unset", report_date)
        report_date = None
    if report_date is None:
        confidences[REPORT_DATE_KEY] = 0.0
    else:
        confidences[REPORT_DATE_KEY] = CONF_READ if order else CONF_DATE_UNSETTLED
    return extracted, confidences, report_date


def text_extract(file_bytes: bytes, fields: list[dict]):
    """Reads the document's text layer and fills `fields` from it. Raises
    ExtractionError when the file has no readable text (a scan, an image)."""
    text = extract_text(file_bytes, max_pages=MAX_PAGES)
    if not text.strip():
        raise ExtractionError(
            "This document has no text the app can read without an API key (a scan or a photo). "
            "Set ANTHROPIC_API_KEY (USE_LIVE_CLAUDE=true) to read it."
        )
    return extract_from_text(text, fields)
