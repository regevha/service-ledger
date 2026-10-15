"""Free-text search over finalized reports (proposal-report-search.md).

What is searchable, per the 2026-10-14 decisions: the text-type fields of the
report's template (and the text columns of its tables), plus the instrument's
model and serial number. Not searchable: numbers, booleans, dates, dropdown
(enum) fields, the lab manager, field names and the scan itself.

`Report.search_text` holds those values joined by newlines. It is kept up to
date by one `before_flush` listener (registered at the bottom of this module),
so every write path — field edits, the worker, template or instrument edits —
refreshes it without each router having to remember to. The query only ever
returns finalized reports; a partial GIN index covers exactly that set.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import event, func, literal_column
from sqlalchemy.dialects.postgresql import TSVECTOR
from sqlalchemy.orm import Session

from app import models

MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 200

# The one text-search expression, shared by the index (models.py, migration)
# and the query below: if these ever differ the query silently falls back to
# a slow scan.
TSVECTOR_SQL = "to_tsvector('simple', coalesce(search_text, ''))"
_TSVECTOR = literal_column(TSVECTOR_SQL, type_=TSVECTOR)


@dataclass(frozen=True)
class Segment:
    """One searchable piece of text and the label shown next to an excerpt."""

    label: str
    text: str


def _label(name: str) -> str:
    return name.replace("_", " ").capitalize()


def _fields_of(field_schema) -> list[dict]:
    """A template's field list: `field_schema` is `{"fields": [...]}`."""
    if isinstance(field_schema, dict):
        field_schema = field_schema.get("fields")
    return [f for f in field_schema or [] if isinstance(f, dict)]


def searchable_segments(
    field_schema, extracted_fields: dict | None, model: str | None, serial: str | None
) -> list[Segment]:
    """The searchable text of one report, in a stable order: instrument model
    and serial first, then template fields in template order."""
    out: list[Segment] = []
    if model:
        out.append(Segment("Instrument model", model))
    if serial:
        out.append(Segment("Instrument serial number", serial))
    fields = extracted_fields or {}
    for field in _fields_of(field_schema):
        name = field.get("name")
        value = fields.get(name)
        kind = field.get("type")
        if kind == "text" and isinstance(value, str) and value.strip():
            out.append(Segment(_label(name), value.strip()))
        elif kind == "object[]" and isinstance(value, list):
            text_columns = [c["name"] for c in field.get("item_schema") or [] if c.get("type") == "text"]
            for row in value:
                if not isinstance(row, dict):
                    continue
                for column in text_columns:
                    cell = row.get(column)
                    if isinstance(cell, str) and cell.strip():
                        out.append(Segment(_label(name), cell.strip()))
    return out


def build_search_text(
    field_schema, extracted_fields: dict | None, model: str | None, serial: str | None
) -> str | None:
    segments = searchable_segments(field_schema, extracted_fields, model, serial)
    return "\n".join(s.text for s in segments) or None


# ---------- Query ----------


def normalize_query(q: str | None) -> str | None:
    """Trimmed query, or None when blank (a blank search is ignored). Raises
    ValueError with a user-facing message when it is too short or too long."""
    if q is None or not q.strip():
        return None
    q = q.strip()
    if len(q) < MIN_QUERY_LENGTH:
        raise ValueError(f"Type at least {MIN_QUERY_LENGTH} characters to search.")
    if len(q) > MAX_QUERY_LENGTH:
        raise ValueError(f"Search text can be at most {MAX_QUERY_LENGTH} characters.")
    return q


def match_expressions(q: str):
    """(match condition, rank) for a query. websearch_to_tsquery accepts what
    people naturally type — words (all required), "quoted phrases", -excluded,
    `or` — and never errors on stray punctuation."""
    query = func.websearch_to_tsquery("simple", q)
    return _TSVECTOR.op("@@")(query), func.ts_rank(_TSVECTOR, query)


def finalized_only():
    return models.Report.status == models.ReportStatus.finalized


# ---------- Excerpts ----------

_PHRASE = re.compile(r'"([^"]+)"')
_EXCERPT_RADIUS = 60


def query_terms(q: str) -> list[str]:
    """The positive search terms of a query, for locating and highlighting
    matches: quoted phrases stay whole, other words are split on whitespace,
    `-excluded` words and the word `or` are dropped. Mirrors what
    websearch_to_tsquery takes as positive terms closely enough for excerpts."""
    terms = [m.strip().lower() for m in _PHRASE.findall(q) if m.strip()]
    rest = _PHRASE.sub(" ", q)
    for word in rest.split():
        if word.startswith("-") or word.lower() == "or":
            continue
        word = word.strip("\"'.,;:!?()[]{}")
        if word:
            terms.append(word.lower())
    return terms


def _term_pattern(terms: list[str]) -> re.Pattern[str] | None:
    if not terms:
        return None
    # Whole-token match: the neighbours must not be word characters.
    alternatives = "|".join(re.escape(t) for t in sorted(set(terms), key=len, reverse=True))
    return re.compile(rf"(?<!\w)(?:{alternatives})(?!\w)", re.IGNORECASE)


def build_excerpt(segments: list[Segment], q: str) -> tuple[list[dict], str] | None:
    """The first segment that contains a query term, cut to a short window
    around the first match, as pieces `{text, matched}` — never HTML, so the
    screen can wrap matches without inserting server text as markup. Returns
    (pieces, field label), or None if nothing is found."""
    pattern = _term_pattern(query_terms(q))
    if pattern is None:
        return None
    for segment in segments:
        first = pattern.search(segment.text)
        if not first:
            continue
        start = max(0, first.start() - _EXCERPT_RADIUS)
        end = min(len(segment.text), first.end() + _EXCERPT_RADIUS)
        window = segment.text[start:end]
        pieces: list[dict] = []
        if start > 0:
            pieces.append({"text": "… ", "matched": False})
        cursor = 0
        for m in pattern.finditer(window):
            if m.start() > cursor:
                pieces.append({"text": window[cursor : m.start()], "matched": False})
            pieces.append({"text": m.group(0), "matched": True})
            cursor = m.end()
        if cursor < len(window):
            pieces.append({"text": window[cursor:], "matched": False})
        if end < len(segment.text):
            pieces.append({"text": " …", "matched": False})
        return pieces, segment.label
    return None


def report_segments(report: models.Report) -> list[Segment]:
    template = report.template
    instrument = report.instrument
    return searchable_segments(
        template.field_schema if template else None,
        report.extracted_fields,
        instrument.model if instrument else None,
        instrument.serial_number if instrument else None,
    )


# ---------- Keeping search_text current ----------


def _compute(session: Session, report: models.Report) -> str | None:
    instrument = session.get(models.Instrument, report.instrument_id) if report.instrument_id else None
    template = session.get(models.ReportTemplate, report.template_id) if report.template_id else None
    return build_search_text(
        template.field_schema if template else None,
        report.extracted_fields,
        instrument.model if instrument else None,
        instrument.serial_number if instrument else None,
    )


def _refresh_search_text(session: Session, flush_context, instances) -> None:
    """Recompute search_text for every new or changed report, and for the
    reports of an instrument whose model/serial changed or a template whose
    fields changed."""
    reports: dict[int, models.Report] = {}
    for obj in list(session.new) + list(session.dirty):
        if isinstance(obj, models.Report):
            reports[id(obj)] = obj
        elif isinstance(obj, models.Instrument) and obj in session.dirty and obj.id is not None:
            for r in session.query(models.Report).filter(models.Report.instrument_id == obj.id):
                reports[id(r)] = r
        elif isinstance(obj, models.ReportTemplate) and obj in session.dirty and obj.id is not None:
            for r in session.query(models.Report).filter(models.Report.template_id == obj.id):
                reports[id(r)] = r
    for report in reports.values():
        value = _compute(session, report)
        if report.search_text != value:
            report.search_text = value


event.listen(Session, "before_flush", _refresh_search_text)
