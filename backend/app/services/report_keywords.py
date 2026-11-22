"""A free, no-model check of whether a text looks like an instrument service report.

Used for HTML, where the text is already in hand: an error page, an invoice or a
login page is stopped before any model call. English and Hebrew terms; each term
counts once. Numbers (weights, cutoffs) are starting values to tune on real files
(settings REPORT_KEYWORD_MIN_SCORE and REPORT_MIN_TEXT_CHARS).
"""
from __future__ import annotations

import re
from typing import NamedTuple

# (weight, pattern) — the terms a service report carries.
_POSITIVE: list[tuple[int, str]] = [
    (3, r"serial\s*(number|no\b|#)|s/n\b|מספר\s*סידורי|מס['׳.]?\s*סידורי"),
    (3, r"work\s*order|service\s*(call|report|order)|קריאת\s*שירות|הזמנת\s*עבודה|דוח\s*שירות|דו[\"״]ח\s*(שירות|טכנאי)"),
    (2, r"labou?r|hours\s*worked|שעות\s*עבודה"),
    (2, r"visit\s*date|date\s*of\s*(visit|service)|תאריך\s*ה?(ביקור|שירות)"),
    (1, r"technician|engineer|field\s*service|טכנאי|מהנדס"),
    (2, r"work\s*performed|work\s*done|actions?\s*taken|עבודה\s*שבוצעה|פעולות\s*שבוצעו"),
    (1, r"fault|failure|problem\s*description|malfunction|תקלה"),
    (2, r"parts?\s*(replaced|used)|replaced\s*parts?|חלקים\s*(שהוחלפו|שהוחלף)|חלקי\s*חילוף"),
    (1, r"instrument|model\b|analy[sz]er|cytometer|מכשיר|דגם|אנליזר"),
    (1, r"maintenance|installation|repair|calibration|upgrade|תחזוקה|התקנה|תיקון|כיול|שדרוג"),
]
# Signs of another kind of document. They count only in the title and the first lines (a real report can
# mention an error code, an "Invoice to" block or a password reset further down), and the penalty is capped.
_NEGATIVE: list[tuple[int, str]] = [
    (3, r"\binvoice\b|tax\s*invoice|חשבונית"),
    (3, r"\b(log\s*in|sign\s*in|forgot\s*your\s*password)\b|התחברות|שכחת\s*סיסמה"),
    (3, r"unsubscribe|newsletter|הסרה\s*מרשימת"),
    (4, r"page\s*not\s*found|\b404\s*(error|not\s*found)|access\s*denied|internal\s*server\s*error"),
]
_HEAD_CHARS = 300
_MAX_PENALTY = 4


class KeywordCheck(NamedTuple):
    score: int
    chars: int
    looks_like_report: bool
    reason: str  # "ok", "nearly_empty" or "low_score"


def check_service_report_text(text: str, *, min_score: int, min_chars: int) -> KeywordCheck:
    """Score `text`; `looks_like_report` is False when it is nearly empty or scores
    below `min_score` (positive terms minus the signs of another document)."""
    chars = len(text.strip())
    lowered = text.lower()
    head = lowered[:_HEAD_CHARS]
    penalty = min(_MAX_PENALTY, sum(w for w, p in _NEGATIVE if re.search(p, head)))
    score = sum(w for w, p in _POSITIVE if re.search(p, lowered)) - penalty
    if chars < min_chars:
        return KeywordCheck(score, chars, False, "nearly_empty")
    if score < min_score:
        return KeywordCheck(score, chars, False, "low_score")
    return KeywordCheck(score, chars, True, "ok")
