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
    (r"repairs?|repaired|breakdowns?|broke(?:n)?|malfunction(?:s|ed|ing)?|faults?|fix(?:es|ed)?", "repair"),
]
STATUSES: list[tuple[str, str]] = [
    (r"in\s+review", "in_review"),
    (r"waiting(?:\s+for\s+review)?|needs?\s+review|to\s+review|awaiting\s+review|unreviewed|(?:not|never)\s+(?:yet\s+)?reviewed|nobody\s+(?:has\s+)?reviewed", "extracted"),
    (r"finali[sz]ed|approved|signed\s+off|done", "finalized"),
    (r"drafts?", "draft"),
]
STOPWORDS = {
    "show", "me", "all", "the", "of", "for", "reports", "report", "from", "in", "at", "with", "a", "an", "and", "on",
    "that", "were", "was", "are", "is", "find", "list", "get", "give", "my", "our", "to", "any", "by", "during", "since",
    "service", "services", "visit", "visits", "please", "which", "have", "has", "been", "last", "this", "past", "recent",
    "serial", "number", "mentioning", "mentioned", "mentions", "mention", "containing", "about", "what", "did", "we", "do",
    "does", "how", "many", "had", "ones", "those", "these", "there", "where",
}
ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6"}

# Comparisons in plain words, tried in this order ("no more than" before "more than", "at least" before "least").
OP_WORD = {"gt": "above", "gte": "at least", "lt": "below", "lte": "at most", "eq": "equal to"}
_COMPARATORS: list[tuple[str, str]] = [
    ("gte", r"at\s+least|no\s+fewer\s+than|no\s+less\s+than|not\s+less\s+than|>=|\u2265"),
    ("lte", r"at\s+most|no\s+more\s+than|not\s+more\s+than|up\s+to|<=|\u2264"),
    ("gt", r"more\s+than|greater\s+than|higher\s+than|bigger\s+than|larger\s+than|exceeding|exceeds|over|above|>"),
    ("lt", r"fewer\s+than|less\s+than|lower\s+than|smaller\s+than|under|below|<"),
    ("eq", r"exactly|equal\s+to|equals?|="),
]
_OPS = "|".join(f"(?P<{op}>{pattern})" for op, pattern in _COMPARATORS)
_NUMBER = r"\d{1,6}(?:\.\d+)?"
# A unit written after the number ("100 mW", "50 psi") is part of the condition, not text to search for.
_UNIT_TOKENS = {"percent", "pct", "psi", "mw", "us", "ms", "hours", "hrs", "hr", "volts", "v", "c", "nm", "mv"}
_UNIT_AFTER = r"(?:\s*(?:" + "|".join(sorted(_UNIT_TOKENS, key=len, reverse=True)) + r"|%))?"
_INSTRUMENT_WORDS = r"(?<![a-z0-9])(?:instruments?|units?|machines?|devices?|equipment)(?![a-z0-9])"


def number_text(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:g}"


def _op_of(m: re.Match[str]) -> str:
    return next(op for op, _ in _COMPARATORS if m.group(op))


def apply_repair_count(out: "Parsed", op: str, count: int) -> None:
    """"Instruments with more than 2 repairs": a question about instruments, not reports. The condition counts finalized
    repairs, so a report type, status, text, lab manager or number condition in the same question cannot apply to it; those
    are left out and said so. Safe to call twice (the rules, then the model's answer)."""
    dropped = []
    for key in ("report_type", "status", "technician", "q", "number_field", "number_op", "number_value"):
        if key in out.filters:
            if key not in ("report_type", "number_op", "number_value"):
                dropped.append({"q": "text", "number_field": "number condition"}.get(key, key))
            del out.filters[key]
    out.understood[:] = [p for p in out.understood if p["key"] not in ("report_type", "status", "technician", "q", "field", "repairs")]
    if dropped:
        note = "Only the model, place and dates apply to a count of repairs per instrument (left out: " + ", ".join(dropped) + ")"
        if note not in out.notes:
            out.notes.append(note)
    out.filters.update({"repairs_op": op, "repairs_count": str(count)})
    words = "no repairs" if (op == "eq" and count == 0) else f"{OP_WORD[op].capitalize()} {count} repair{'' if count == 1 else 's'}"
    out.understood.append({"key": "repairs", "label": words})


_NO_REPAIRS = re.compile(
    r"(?<![a-z0-9])(?:(?:no|zero)\s+repairs?|without\s+(?:any\s+|a\s+)?repairs?"
    r"|never\s+(?:had\s+(?:a\s+|any\s+)?repairs?|been\s+repaired|repaired|needed\s+(?:a\s+|any\s+)?repairs?))(?![a-z0-9])(?!\s+(?:reports?|visits?|forms?))"
)
_REPAIR_COUNT = re.compile(
    rf"(?<![a-z0-9])(?:(?:{_OPS})\s*)?(?P<n>\d{{1,5}})(?:\s+or\s+(?P<tail>more|fewer|less))?\s+repairs?(?![a-z0-9])(?!\s+(?:reports?|visits?|forms?))"
)


def _take_repair_count(rest: str) -> tuple[str, tuple[str, int] | None]:
    """"more than 2 repairs", "3 or more repairs", "no repairs", "never had a repair": the comparison and the number,
    and the text with those words (and the word "instruments") removed. A bare "3 repairs" counts only when the
    question is about instruments."""
    m = _NO_REPAIRS.search(rest)
    if m:
        rest = rest[: m.start()] + " " + rest[m.end() :]
        return re.sub(_INSTRUMENT_WORDS, " ", rest), ("eq", 0)
    m = _REPAIR_COUNT.search(rest)
    if not m:
        return rest, None
    op = _op_of(m) if any(m.group(o) for o, _ in _COMPARATORS) else None
    if op is None and m.group("tail"):
        op = "gte" if m.group("tail") == "more" else "lte"
    if op is None:
        if not re.search(_INSTRUMENT_WORDS, rest):
            return rest, None
        op = "eq"
    rest = rest[: m.start()] + " " + rest[m.end() :]
    return re.sub(_INSTRUMENT_WORDS, " ", rest), (op, int(m.group("n")))


def _field_words(name: str) -> list[str]:
    """The ways a field may be written: laser_delay as "laser delay", and without a unit at its end (baseline_cv_percent)."""
    words = [w for w in re.split(r"[_\s\-]+", name.lower()) if w]
    variants = [words]
    if len(words) > 1 and words[-1] in _UNIT_TOKENS:
        variants.append(words[:-1])
    return [r"[\s\-_]*".join(re.escape(w) for w in v) for v in variants]


def _take_field_condition(out: "Parsed", known: "Known", rest: str) -> str:
    """"Laser delay above 29", "labor hours more than 4", "laser power below 100 mW": a field the app knows, a comparison
    and a number. Only fields that exist are read; anything else stays text."""
    for name in sorted(known.fields, key=len, reverse=True):
        for pattern in _field_words(name):
            m = re.search(
                rf"(?<![a-z0-9])(?:{pattern})(?:\s+(?:is|was|were|are|of))?\s*(?:{_OPS})\s*(?P<num>{_NUMBER}){_UNIT_AFTER}(?![a-z0-9%])",
                rest,
            )
            if not m:
                continue
            op, value = _op_of(m), float(m.group("num"))
            out.filters.update({"number_field": name, "number_op": op, "number_value": number_text(value)})
            out.understood.append({"key": "field", "label": f"{name.replace('_', ' ').capitalize()} {OP_WORD[op]} {number_text(value)}"})
            return rest[: m.start()] + " " + rest[m.end() :]
    return rest


@dataclass
class Known:
    """What the app already knows by name, so the sentence can point at a record."""

    models: list[tuple[str, str]] = field(default_factory=list)  # (id, name)
    places: list[tuple[str, str]] = field(default_factory=list)  # (id, name)
    instruments: list[tuple[str, str, str | None]] = field(default_factory=list)  # (id, model, serial)
    # Names of the fields that hold numbers (see report_filters.numeric_field_names), for a condition like "laser delay above 29".
    fields: list[str] = field(default_factory=list)


@dataclass
class Parsed:
    filters: dict[str, str] = field(default_factory=dict)
    understood: list[dict[str, str]] = field(default_factory=list)
    leftover: str = ""
    source: str = "rules"  # "rules", "ai" (the model filled gaps) or "rules_fallback" (the model was wanted but failed)
    notes: list[str] = field(default_factory=list)  # parts of the question that no filter can express

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
    m, rest = _take(r"(since\s+|in\s+|during\s+|from\s+|before\s+|until\s+|after\s+)?(" + "|".join(sorted(MONTHS, key=len, reverse=True)) + r")(?:\s+(\d{4}))?", text)
    if m:
        month = MONTHS[m.group(2)]
        year = int(m.group(3)) if m.group(3) else (today.year if month <= today.month else today.year - 1)
        start, end = _month_bounds(year, month)
        word = (m.group(1) or "").strip()
        if word == "since":
            return start, None, rest
        if word in ("before", "until"):
            return None, (start - timedelta(days=1) if word == "before" else end), rest
        if word == "after":
            return end + timedelta(days=1), None, rest
        return start, end, rest

    # "in 2025", "2025"
    m, rest = _take(r"(in\s+|during\s+|from\s+|since\s+|before\s+|until\s+|after\s+)?(20\d{2})", text)
    if m:
        word = (m.group(1) or "").strip()
        year = int(m.group(2))
        if word == "since":
            return date(year, 1, 1), None, rest
        if word == "before":
            return None, date(year - 1, 12, 31), rest
        if word == "until":
            return None, date(year, 12, 31), rest
        if word == "after":
            return date(year + 1, 1, 1), None, rest
        return date(year, 1, 1), date(year, 12, 31), rest
    return None, None, text


def _months_back(today: date, months: int) -> date:
    index = today.year * 12 + today.month - 1 - months
    year, month = divmod(index, 12)
    return date(year, month + 1, min(today.day, calendar.monthrange(year, month + 1)[1]))


def _model_names(name: str) -> list[str]:
    """The ways a person might shorten a model name: "LSRFortessa" -> "Fortessa", "BD FACSAria III" -> "FACSAria III"."""
    names = [name]
    camel = re.match(r"^([A-Z]{2,})([A-Z][a-z].*)$", name)
    if camel:
        names.append(camel.group(2))
    words = name.split()
    if len(words) > 1 and len(" ".join(words[1:])) >= 5:
        names.append(" ".join(words[1:]))
    return names


def _loose(name: str) -> str:
    """A pattern that ignores case, spaces and dashes, and lets a trailing roman numeral be written as a digit."""
    words = re.sub(r"[\-_]+", " ", name.lower()).split()
    tail = ""
    if len(words) > 1 and words[-1] in ROMAN:
        tail = ROMAN[words.pop()]
        last = re.escape(tail)
    squashed = "".join(words)
    body = r"[\s\-_]*".join(re.escape(ch) for ch in squashed)
    if tail:
        roman = next(r for r, d in ROMAN.items() if d == tail)
        return rf"{body}[\s\-_]*(?:{roman}|{last})"
    return body


def _model_patterns(models: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    """(id, name, pattern) for each model, longest wording first; a short form is used only if no other model shares it."""
    forms: list[tuple[str, str, str]] = []
    for model_id, name in models:
        for alias in _model_names(name):
            forms.append((model_id, name, alias))
    count: dict[str, int] = {}
    for _, _, alias in forms:
        key = re.sub(r"[^a-z0-9]+", "", alias.lower())
        count[key] = count.get(key, 0) + 1
    keep = [f for f in forms if count[re.sub(r"[^a-z0-9]+", "", f[2].lower())] == 1 or f[2] == f[1]]
    keep.sort(key=lambda f: -len(f[2]))
    return [(mid, name, _loose(alias)) for mid, name, alias in keep]


def parse_search(text: str, known: Known, today: date) -> Parsed:
    """The filters a request asks for, what was understood, and the words left over as free text."""
    out = Parsed()
    rest = " " + re.sub(r"\s+", " ", text.lower()).strip() + " "

    # Instrument model, place and serial first: they are the longest, most specific phrases.
    for model_id, name, pattern in _model_patterns(known.models):
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

    rest = _take_field_condition(out, known, rest)
    rest, repairs = _take_repair_count(rest)

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

    m = re.search(r"(?:\bby\b|technician|lab\s+manager|engineer)\s+([a-z][a-z'\-]*\.?(?:\s+[a-z][a-z'\-]+)?)", rest)
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
    if repairs:
        apply_repair_count(out, *repairs)
    return out
