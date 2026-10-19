"""Catch a mistyped copy of the instrument's serial number in extracted text.

Why: a BD Work Order Service Report is free text in places. The S8 software
upgrade report has the Subject line "... S8 S/N R6651580000057" while the
instrument's serial, printed in the Installed Product box, is MP6651580000057.
Extraction copies the Subject line into `service_description`, so a wrong serial
ended up in the stored report on every live run of that document. The instrument
is already known by the time extraction runs (it was matched or chosen first),
so its serial is the reference.

Rule, deliberately narrow: in a top-level text value, a serial-looking word
(letters and digits, at least eight characters, at least one digit) that is not
the instrument's serial but within a small edit distance of it is replaced with
the instrument's serial as stored. The allowed distance depends on the serial's
length (none under eight characters, one up to nine, two from ten), so short
serials and unrelated identifiers (work orders, part numbers, contract numbers)
are never touched. Only text the model wrote is changed, never numbers, lists or
tables, and every change is returned so the worker can log it.
"""
from __future__ import annotations

import re
from typing import NamedTuple

_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{6,}[A-Za-z0-9]")


class SerialFix(NamedTuple):
    field: str
    found: str


def _normalize(text: str) -> str:
    return "".join(ch for ch in text.upper() if ch.isalnum())


def _allowed_distance(serial: str) -> int:
    if len(serial) >= 10:
        return 2
    if len(serial) >= 8:
        return 1
    return 0


def _edit_distance(a: str, b: str, limit: int) -> int:
    """Levenshtein distance, giving up (returning limit + 1) past `limit`."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        if min(current) > limit:
            return limit + 1
        previous = current
    return previous[-1]


def correct_serial_typos(extracted_fields: dict, serial: str) -> list[SerialFix]:
    """Fix near-miss copies of `serial` inside top-level string values of
    `extracted_fields`, in place. Returns what was changed."""
    wanted = _normalize(serial)
    limit = _allowed_distance(wanted)
    fixes: list[SerialFix] = []
    if limit == 0:
        return fixes

    for name, value in extracted_fields.items():
        if not isinstance(value, str):
            continue

        def _replace(match: re.Match) -> str:
            word = match.group(0)
            normalized = _normalize(word)
            if (
                normalized in wanted  # the serial itself, or a correct part of it ("MP 6651580000057")
                or not any(ch.isdigit() for ch in normalized)
                or _edit_distance(normalized, wanted, limit) > limit
            ):
                return word
            fixes.append(SerialFix(name, word))
            return serial

        extracted_fields[name] = _WORD.sub(_replace, value)
    return fixes
