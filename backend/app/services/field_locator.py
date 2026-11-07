"""Where on a PDF each extracted field value was read from.

The extraction returns a value and a confidence per field, not where on the page it came from. For a PDF with a
text layer that place can be found afterwards: the value is looked up among the page's words (page_text.py),
allowing for how a form writes the same thing differently (29.4 and 29.40, 2026-09-14 and 14 Sep 2026).

When a value shows up more than once the label decides: the words just before a match are compared with the
field's label, and the best fit wins. A value that is on the page only once is certain; one that is on it
several times with nothing to tell them apart is flagged `ambiguous`, so the screen can say the position is a
guess. A value that is nowhere on the page (the reading worked it out from other fields) has no location, and a
field whose template carries a position (the "pick it on the PDF" editor) falls back to that.

Scans and photos have no text layer, so nothing here can find anything on them.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from app.services.page_text import WordBox, page_words

MAX_PAGES = 12
# How many words before a match are read as its label.
_LABEL_WINDOW = 6
_EDGE_PUNCT = ".,;:()[]{}\"'"
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float


@dataclass
class FieldLocation:
    page: int
    rects: list[Rect]
    matches: int
    ambiguous: bool
    source: str  # "text": found among the page's words; "template": the template's own position


@dataclass
class FieldToLocate:
    name: str
    label: str
    value: object
    source: dict | None = None  # the template's {page, x, y, w, h}, if it has one
    # What the field holds now, tried when `value` (what was first read) is not on the page: a person may have
    # corrected it to something that is.
    alt: object = None


@dataclass
class Located:
    has_text: bool
    page_count: int
    fields: dict[str, FieldLocation] = field(default_factory=dict)


def _norm(token: str) -> str:
    return token.strip(_EDGE_PUNCT).lower()


def _same_token(a: str, b: str) -> bool:
    if a == b:
        return True
    try:
        return float(a.replace(",", "")) == float(b.replace(",", ""))
    except ValueError:
        return False


def _date_variants(iso: str) -> list[str]:
    m = _ISO_DATE.match(iso)
    if not m:
        return []
    y, mo, d = int(m[1]), int(m[2]), int(m[3])
    try:
        date(y, mo, d)
    except ValueError:
        return []
    mon = _MONTHS[mo - 1]
    return [
        f"{d} {mon} {y}",
        f"{d:02d} {mon} {y}",
        f"{mon} {d}, {y}",
        f"{d:02d}/{mo:02d}/{y}",
        f"{d}/{mo}/{y}",
        f"{mo:02d}/{d:02d}/{y}",
        f"{d:02d}.{mo:02d}.{y}",
        f"{d:02d}-{mo:02d}-{y}",
        iso,
    ]


def _scalar_text(value: object) -> str | None:
    """The text a scalar value would be written as on the form; None for anything that is not one."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _variants(text: str) -> list[list[str]]:
    out = [text] + _date_variants(text)
    seen: list[list[str]] = []
    for variant in out:
        tokens = [t for t in (_norm(p) for p in variant.split()) if t]
        if tokens and tokens not in seen:
            seen.append(tokens)
    return seen


def _label_tokens(label: str) -> set[str]:
    return {t for t in (_norm(p) for p in re.split(r"[\s_/-]+", label)) if len(t) > 2}


def _find(words: list[WordBox], tokens: list[str]) -> list[int]:
    norm = [_norm(w.text) for w in words]
    n = len(tokens)
    return [i for i in range(len(norm) - n + 1) if all(_same_token(norm[i + k], tokens[k]) for k in range(n))]


def _rects(words: list[WordBox]) -> list[Rect]:
    """One rectangle per line of the words, so a value that wraps is drawn as the lines it sits on."""
    by_line: dict[int, list[WordBox]] = {}
    for w in words:
        by_line.setdefault(w.line, []).append(w)
    rects = []
    for line_words in by_line.values():
        x0 = min(w.x for w in line_words)
        y0 = min(w.y for w in line_words)
        x1 = max(w.x + w.w for w in line_words)
        y1 = max(w.y + w.h for w in line_words)
        rects.append(Rect(x=x0, y=y0, w=x1 - x0, h=y1 - y0))
    return rects


def locate_fields(path: str | Path, wanted: list[FieldToLocate]) -> Located:
    import pypdfium2 as pdfium

    from app.services.page_text import PDFIUM_LOCK

    with PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(str(path))
        try:
            page_count = len(pdf)
        finally:
            pdf.close()

    pages: list[tuple[int, list[WordBox]]] = []
    has_text = False
    for page in range(1, min(page_count, MAX_PAGES) + 1):
        words, page_has_text = page_words(path, page)
        has_text = has_text or page_has_text
        pages.append((page, words))
    result = Located(has_text=has_text, page_count=page_count)

    used: set[tuple[int, int]] = set()
    page_words_by_number = dict(pages)

    def find_text(item: FieldToLocate, text: str) -> FieldLocation | None:
        labels = _label_tokens(item.label or item.name)
        candidates: list[tuple[int, int, int, int]] = []  # (label score, page, start, length)
        for page, words in pages:
            for tokens in _variants(text):
                for start in _find(words, tokens):
                    if (page, start) in used:
                        continue
                    before = {_norm(w.text) for w in words[max(0, start - _LABEL_WINDOW) : start]}
                    candidates.append((len(labels & before), page, start, len(tokens)))
        if not candidates:
            return None
        score, page, start, length = max(candidates, key=lambda c: (c[0], -c[1], -c[2]))
        used.add((page, start))
        return FieldLocation(
            page=page,
            rects=_rects(page_words_by_number[page][start : start + length]),
            matches=len(candidates),
            ambiguous=len(candidates) > 1 and score == 0,
            source="text",
        )

    for item in wanted:
        location: FieldLocation | None = None
        if has_text:
            for value in (item.value, item.alt):
                text = _scalar_text(value)
                if text is not None:
                    location = find_text(item, text)
                    if location is not None:
                        break
        if location is None and item.source:
            s = item.source
            try:
                location = FieldLocation(
                    page=int(s["page"]),
                    rects=[Rect(x=float(s["x"]), y=float(s["y"]), w=float(s["w"]), h=float(s["h"]))],
                    matches=1,
                    ambiguous=False,
                    source="template",
                )
            except (KeyError, TypeError, ValueError):
                location = None
        if location is not None:
            result.fields[item.name] = location
    return result
