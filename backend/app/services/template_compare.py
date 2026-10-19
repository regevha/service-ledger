"""Side-by-side comparison of two templates (proposal-template-comparison.md,
phase 1). Advice for a person only: nothing here writes, merges or renames, and
what to do about a difference stays a human decision.

Fields are matched by name with case, spaces, underscores and hyphens ignored
("Labor hours" and "labor_hours" are the same field). Different names for the
same concept are phase 2 (the alias table); until then they show as one field
only on each side.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.models import ReportTemplate

SAME = "same"
DIFFERS = "differs"
ONLY_LEFT = "only_left"
ONLY_RIGHT = "only_right"

# Compared in this order, so a row's list of differences reads the same way
# everywhere. "name" means the same field spelled differently.
ATTRIBUTES = ("name", "type", "unit", "notes", "options", "item_schema")

_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_SPACES = re.compile(r"\s+")


def normalize_name(name: str) -> str:
    return _NON_ALNUM.sub("", name.lower())


def _text(value: object) -> str:
    """Notes and units: blank and missing are the same, runs of whitespace are one space."""
    return _SPACES.sub(" ", str(value or "")).strip()


def _options(value: object) -> frozenset[str]:
    return frozenset(_text(o) for o in (value or []))


def _columns(value: object) -> list[tuple[str, str]]:
    return [(_text(c.get("name")), _text(c.get("type"))) for c in (value or [])]


def differing_attributes(left: dict, right: dict) -> list[str]:
    """Which attributes of two same-named fields differ, in ATTRIBUTES order."""
    found = []
    if left.get("name") != right.get("name"):
        found.append("name")
    if left.get("type") != right.get("type"):
        found.append("type")
    if _text(left.get("unit")) != _text(right.get("unit")):
        found.append("unit")
    if _text(left.get("notes")) != _text(right.get("notes")):
        found.append("notes")
    if _options(left.get("options")) != _options(right.get("options")):
        found.append("options")
    if _columns(left.get("item_schema")) != _columns(right.get("item_schema")):
        found.append("item_schema")
    return found


@dataclass
class CompareRow:
    status: str
    name: str
    differences: list[str] = field(default_factory=list)
    left: dict | None = None
    right: dict | None = None


@dataclass
class Comparison:
    rows: list[CompareRow]
    left_count: int
    right_count: int

    def count(self, status: str) -> int:
        return sum(1 for r in self.rows if r.status == status)


def compare_templates(left: ReportTemplate, right: ReportTemplate) -> Comparison:
    """Rows in the left template's field order, then the fields only the right
    one has in its own order, so the left template reads top to bottom as it
    does on its own screen. Two fields of one template that normalize to the
    same name are matched one-to-one in order rather than collapsed."""
    left_fields = list(left.field_schema.get("fields", []))
    right_fields = list(right.field_schema.get("fields", []))

    waiting: dict[str, list[int]] = {}
    for index, f in enumerate(right_fields):
        waiting.setdefault(normalize_name(f["name"]), []).append(index)

    used: set[int] = set()
    rows: list[CompareRow] = []
    for f in left_fields:
        queue = waiting.get(normalize_name(f["name"]))
        if queue:
            index = queue.pop(0)
            used.add(index)
            other = right_fields[index]
            differences = differing_attributes(f, other)
            rows.append(
                CompareRow(
                    status=DIFFERS if differences else SAME,
                    name=f["name"],
                    differences=differences,
                    left=f,
                    right=other,
                )
            )
        else:
            rows.append(CompareRow(status=ONLY_LEFT, name=f["name"], left=f))
    for index, f in enumerate(right_fields):
        if index not in used:
            rows.append(CompareRow(status=ONLY_RIGHT, name=f["name"], right=f))
    return Comparison(rows=rows, left_count=len(left_fields), right_count=len(right_fields))
