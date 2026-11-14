"""One rule for "was the reading kept?", used by the accuracy page, the Home tile and scripts/reread_baseline.py,
so their figures cannot drift apart (SL-70).

A field the reading filled in is kept when the approved value equals it. Exactly, with one exception: the
free-text fields (the narrative a technician writes, where the same facts come out in different words and a
person often only tidies them) are compared ignoring case, spacing and punctuation, and nothing else: a changed
number, word or order still counts as a change. The list is by field name, not guessed from the field type,
because a serial number is also a "text" field and must stay exact.
"""
from __future__ import annotations

import unicodedata

FREE_TEXT_FIELDS = frozenset({"work_performed", "fault_description", "root_cause", "service_description"})


def is_free_text(field: str) -> bool:
    return field in FREE_TEXT_FIELDS


def blank(value: object) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "") or value == [] or value == {}


def _loose(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = "".join(" " if unicodedata.category(ch).startswith("P") else ch for ch in text)
    return " ".join(text.split())


def same_value(field: str, read: object, kept: object) -> bool:
    if isinstance(read, str) and isinstance(kept, str):
        if is_free_text(field):
            return _loose(read) == _loose(kept)
        return read.strip() == kept.strip()
    return read == kept
