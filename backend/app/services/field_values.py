"""Small rules applied to every value read from a document, whichever reader
produced it (the live model, the text layer or the stub)."""
from __future__ import annotations

import math

from app.schemas import TemplateFieldType


def round_to_quarter_hour(hours: float) -> float:
    """The nearest quarter hour (1.42 -> 1.5, 3.1 -> 3.0); halves round up."""
    return math.floor(hours * 4 + 0.5) / 4


def as_choice_list(value) -> list[str]:
    """A choices value as a list of non-empty strings; a single string (the
    old one-choice shape) becomes a one-item list, anything else an empty one."""
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [v.strip() for v in value if isinstance(v, str) and v.strip()]
    return []


def normalize_values(fields: list[dict], values: dict) -> dict:
    """The extracted values with hour fields rounded to the nearest quarter
    hour and choice-list fields made lists. Other values are left alone."""
    out = dict(values)
    for field in fields:
        name, value = field["name"], out.get(field["name"])
        if field["type"] == TemplateFieldType.number and field.get("unit") == "hours":
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                out[name] = round_to_quarter_hour(float(value))
        elif field["type"] == TemplateFieldType.enum_list and name in out:
            out[name] = as_choice_list(value)
    return out
