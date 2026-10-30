"""The privacy rule for stored values, as a check in code.

No person's name and no contract detail may be stored in any field, free text
included (write "the engineer" or "the customer" instead). The extraction
prompt asks for that; this is the net under it: it removes what the pattern
rules below can recognise if one slips through. It cannot recognise an
arbitrary name in running text, so the prompt remains the first line of
defence, and a field changed here is marked as doubtful so a person looks at it.
"""
from __future__ import annotations

import re

from app.schemas import TemplateFieldType

# "By A. Engineer on 18/04/2021": a sign-off attribution.
_BY_ON = re.compile(r"\s*[,;.\-–]?\s*\b(?i:by)\s+(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}\s+(?i:on)\s+\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}")
# A role label followed by a name: "Engineer: Jane Doe", "Signed by John Smith".
_ROLE_NAME = re.compile(
    r"\b((?i:engineer|technician|customer|contact|signed by|approved by|name))\s*(?::|\s[-–]\s)\s*"
    r"(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}"
)
_CONTRACT_NUMBER = re.compile(r"\b(?:service\s+)?contract\s*(?:no\.?|number|#|id)?\s*[:#]?\s*[A-Z]{0,4}\d[\w-]{3,}", re.I)
_SMX = re.compile(r"\bSMX\d{5,}\b")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?<![\w/])(?:\+\d[\d\s-]{7,}\d|0\d{1,3}[\s-]\d{3,4}[\s-]?\d{3,4})(?![\w/])")

_SIGNED_BY = re.compile(r"\b(?i:signed|approved|checked|reviewed) by\s+(?:[A-Z]\.|[A-Z][\w'’-]+)(?:\s+(?:[A-Z]\.|[A-Z][\w'’-]+)){0,3}")
_ROLES = {"engineer", "technician", "customer", "contact"}


def scrub_text(text: str) -> str:
    """The text without sign-off attributions, role-and-name pairs, contract
    numbers, e-mail addresses and phone numbers."""
    out = _ROLE_NAME.sub(lambda m: m.group(1).lower() if m.group(1).lower() in _ROLES else "", text)
    for rule in (_BY_ON, _SIGNED_BY, _CONTRACT_NUMBER, _SMX, _EMAIL):
        out = rule.sub("", out)
    # A phone number needs 8 or more digits in a row, so part numbers and dates stay.
    out = _PHONE.sub("", out)
    out = re.sub(r"[ \t]{2,}", " ", out)
    return re.sub(r"\s+/\s*$", "", out).lstrip(" ,;.-–").rstrip(" ,;-–")


def _scrub_value(value):
    if isinstance(value, str):
        return scrub_text(value)
    if isinstance(value, list):
        return [_scrub_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _scrub_value(v) for k, v in value.items()}
    return value


def scrub_values(fields: list[dict], values: dict) -> tuple[dict, set[str]]:
    """(values with the privacy rule applied to text fields and table text
    cells, names of the fields that were changed)."""
    out, changed = dict(values), set()
    for field in fields:
        name = field["name"]
        if name not in out or field["type"] not in (TemplateFieldType.text, TemplateFieldType.object_list):
            continue
        cleaned = _scrub_value(out[name])
        if cleaned != out[name]:
            out[name], changed = cleaned, changed | {name}
    return out, changed
