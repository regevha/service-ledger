"""Turns a sentence like "repairs of the FACSAria III last month" into the Reports filters.

The Reports list already has filters for report type, status, dates, instrument model, instrument, place, lab
manager and free text. This reads a short English request and fills those same filters, so the person can type
what they want in one box and still see (and change) exactly what was understood. It works from rules and the
names the app already holds (models, places, serial numbers), so it needs no model call and gives the same answer
for the same words. Whatever it cannot place is left as free text rather than guessed.
"""
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass, field
from datetime import date, timedelta

MONTHS = {name.lower(): i for i, name in enumerate(calendar.month_name) if name}
MONTHS.update({name.lower(): i for i, name in enumerate(calendar.month_abbr) if name})
MONTHS["sept"] = 9

REPORT_TYPES: list[tuple[str, str]] = [
    (r"preventive\s+maintenance|preventative\s+maintenance|\bpm\b|maintenance|service\s+visits?", "preventive_maintenance"),
    (r"installations?|installed|upgrades?|upgraded", "installation_upgrade"),
    (r"repairs?|repaired|breakdowns?|fix(?:es|ed)?", "repair"),
]
STATUSES: list[tuple[str, str]] = [
    (r"in\s+review", "in_review"),
    (r"waiting(?:\s+for\s+review)?|needs?\s+review|to\s+review|awaiting\s+review|unreviewed", "extracted"),
    (r"finali[sz]ed|approved|signed\s+off|done", "finalized"),
    (r"drafts?", "draft"),
]
STOPWORDS = {
    "show", "me", "all", "the", "of", "for", "reports", "report", "from", "in", "at", "with", "a", "an", "and", "on",
    "that", "were", "was", "are", "is", "find", "list", "get", "give", "my", "our", "to", "any", "by", "during", "since",
    "service", "services", "visit", "visits", "please", "which", "have", "has", "been", "last", "this", "past", "recent",
}


@dataclass
class Known:
    """What the app already knows by name, so the sentence can point at a record."""

    models: list[tuple[str, str]] = field(default_factory=list)  # (id, name)
    places: list[tuple[str, str]] = field(default_factory=list)  # (id, name)
    instruments: list[tuple[str, str, str | None]] = field(default_factory=list)  # (id, model, serial)


@dataclass
class Parsed:
    filters: dict[str, str] = field(default_factory=dict)
    understood: list[dict[str, str]] = field(default_factory=list)
    leftover: str = ""

    def add(self, key: str, value: str, label: str) -> None:
        self.filters[key] = value
        self.understood.append({"key": key, "label": label})


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _take(pattern: str, text: str) -> tuple[re.Match[str] | None, str]:
    """First match of `pattern` as whole words, and the text with that span blanked out."""
    m = re.search(rf"(?<![a-z0-9])(?:{pattern})(?![a-z0-9])", text)
    if not m:
        return None, text
    return m, text[: m.start()] + " " + text[m.end() :]


def _span(start: date, end: date) -> tuple[str, str]:
    return start.isoformat(), end.isoformat()


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def _label_dates(start: date | None, end: date | None) -> str:
    def fmt(d: date) -> str:
        return f"{d.day} {calendar.month_abbr[d.month]} {d.year}"

    if start and end:
        return f"{fmt(start)} to {fmt(end)}"
    return f"From {fmt(start)}" if start else f"Until {fmt(end)}"  # type: ignore[arg-type]


def _dates(text: str, today: date) -> tuple[date | None, date | None, str]:
    """A date range from the words in `text`, and the text with those words removed."""
    patterns: list[tuple[str, object]] = []

    def rel(name: str, fn) -> None:  # noqa: ANN001
        patterns.append((name, fn))

    def monday(d: date) -> date:
        return d - timedelta(days=d.weekday())

    rel(r"today", lambda m: (today, today))
    rel(r"yesterday", lambda m: (today - timedelta(days=1),) * 2)
    rel(r"this\s+week", lambda m: (monday(today), today))
    rel(r"last\s+week", lambda m: (monday(today) - timedelta(days=7), monday(today) - timedelta(days=1)))
    rel(r"this\s+month", lambda m: (today.replace(day=1), today))
    rel(
        r"last\s+month",
        lambda m: _month_bounds(*((today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12))),
    )
    rel(r"this\s+year", lambda m: (date(today.year, 1, 1), today))
    rel(r"last\s+year", lambda m: (date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)))
    rel(r"(?:in\s+the\s+)?(?:last|past)\s+(\d{1,3})\s+days?", lambda m: (today - timedelta(days=int(m.group(1))), today))
    rel(r"(?:in\s+the\s+)?(?:last|past)\s+(\d{1,3})\s+weeks?", lambda m: (today - timedelta(weeks=int(m.group(1))), today))
    rel(r"(?:in\s+the\s+)?(?:last|past)\s+(\d{1,2})\s+months?", lambda m: (_months_back(today, int(m.group(1))), today))

    for pattern, fn in patterns:
        m, rest = _take(pattern, text)
        if m:
            start, end = fn(m)  # type: ignore[operator]
            return start, end, rest

    # "since 2026-03-01", "after ...", "before ...", "until ..."
    m, rest = _take(r"(since|from|after|before|until|up\s+to)\s+(\d{4})-(\d{2})-(\d{2})", text)
    if m:
        try:
            day = date(int(m.group(2)), int(m.group(3)), int(m.group(4)))
        except ValueError:
            return None, None, text
        word = m.group(1)
        return (None, day, rest) if word in ("before", "until") or word.startswith("up") else (day, None, rest)

    # "March 2026", "in March", "since March"
    m, rest = _take(r"(since\s+|in\s+|during\s+|from\s+)?(" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")(?:\s+(\d{4}))?", text)
    if m:
        month = MONTHS[m.group(2)]
        year = int(m.group(3)) if m.group(3) else (today.year if month <= today.month else today.year - 1)
        start, end = _month_bounds(year, month)
        if m.group(1) and m.group(1).strip() == "since":
            return start, None, rest
        return start, end, rest

    # "in 2025", "2025"
    m, rest = _take(r"(?:in\s+|during\s+|from\s+)?(20\d{2})", text)
    if m:
        year = int(m.group(1))
        return date(year, 1, 1), date(year, 12, 31), rest
    return None, None, text


def _months_back(today: date, months: int) -> date:
    index = today.year * 12 + today.month - 1 - months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(today.day, calendar.monthrange(year, month + 1)[1]))


def parse_search(text: str, known: Known, today: date) -> Parsed:
    """The filters a request asks for, what was understood, and the words left over as free text."""
    out = Parsed()
    rest = " " + re.sub(r"\s+", " ", text.lower()).strip() + " "

    # Instrument model, place and serial first: they are the longest, most specific phrases.
    for model_id, name in sorted(known.models, key=lambda m: -len(m[1])):
        pattern = r"[\s\-_]*".join(re.escape(ch) for ch in re.sub(r"[\s\-_]+", "", name.lower()))
        m = re.search(rf"(?<![a-z0-9]){pattern}(?![a-z0-9])", rest)
        if m:
            out.add("model_id", model_id, f"Model: {name}")
            rest = rest[: m.start()] + " " + rest[m.end() :]
            break
    for instrument_id, model, serial in known.instruments:
        if serial and len(serial) >= 4:
            m = re.search(rf"(?<![a-z0-9]){re.escape(serial.lower())}(?![a-z0-9])", rest)
            if m:
                out.add("instrument_id", instrument_id, f"Instrument: {model} · {serial}")
                rest = rest[: m.start()] + " " + rest[m.end() :]
                break
    for place_id, name in sorted(known.places, key=lambda p: -len(p[1])):
        if len(name) < 3:
            continue
        m = re.search(rf"(?<![a-z0-9]){re.escape(name.lower())}(?![a-z0-9])", rest)
        if m:
            out.add("place_id", place_id, f"Place: {name}")
            rest = rest[: m.start()] + " " + rest[m.end() :]
            break

    for pattern, value in REPORT_TYPES:
        m, rest2 = _take(pattern, rest)
        if m:
            out.add("report_type", value, {"repair": "Repair", "preventive_maintenance": "Preventive maintenance", "installation_upgrade": "Installation / upgrade"}[value])
            rest = rest2
            break
    for pattern, value in STATUSES:
        m, rest2 = _take(pattern, rest)
        if m:
            out.add("status", value, {"in_review": "Status: In review", "extracted": "Status: Read, waiting for review", "finalized": "Status: Finalized", "draft": "Status: Draft"}[value])
            rest = rest2
            break

    start, end, rest = _dates(rest, today)
    if start or end:
        if start:
            out.filters["date_from"] = start.isoformat()
        if end:
            out.filters["date_to"] = end.isoformat()
        out.understood.append({"key": "date", "label": _label_dates(start, end)})

    m = re.search(r"(?:\bby\b|technician|lab\s+manager|engineer)\s+([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+)?)", rest)
    if m:
        name = m.group(1)
        words = [w for w in name.split() if w not in STOPWORDS]
        if words:
            name = " ".join(words)
            out.add("technician", name, f"Lab manager: {name.title()}")
            rest = rest[: m.start()] + " " + rest[m.end() :]

    leftover = " ".join(w for w in re.findall(r"[a-z0-9][a-z0-9'\-]*", rest) if w not in STOPWORDS)
    if len(leftover) >= 2:
        out.leftover = leftover
        out.add("q", leftover, f"Text: {leftover}")
    return out
