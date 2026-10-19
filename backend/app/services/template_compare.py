"""Side-by-side comparison of two templates (proposal-template-comparison.md,
phase 1). Advice for a person only: nothing here writes, merges or renames, and
what to do about a difference stays a human decision.

Fields are matched by name with case, spaces, underscores and hyphens ignored
("Labor hours" and "labor_hours" are the same field). Fields left over on each
side are then paired when an alias group (field_aliases.py) lists their names as
the same concept: a "possible match", shown next to each other with their
differences, never treated as equal.
"""
from __future__ import annotations

import re
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field

from app.models import ReportTemplate

SAME = "same"
DIFFERS = "differs"
ONLY_LEFT = "only_left"
ONLY_RIGHT = "only_right"
POSSIBLE_MATCH = "possible_match"

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


@dataclass(frozen=True)
class AliasConcept:
    """An alias group as the comparison needs it."""

    id: uuid.UUID
    label: str | None
    names: tuple[str, ...]


@dataclass
class CompareRow:
    status: str
    name: str
    differences: list[str] = field(default_factory=list)
    left: dict | None = None
    right: dict | None = None
    concept: AliasConcept | None = None


@dataclass
class Comparison:
    rows: list[CompareRow]
    left_count: int
    right_count: int

    def count(self, status: str) -> int:
        return sum(1 for r in self.rows if r.status == status)


def compare_templates(
    left: ReportTemplate,
    right: ReportTemplate,
    aliases: Mapping[str, AliasConcept] | None = None,
) -> Comparison:
    """Rows in the left template's field order, then the fields only the right
    one has in its own order, so the left template reads top to bottom as it
    does on its own screen. Two fields of one template that normalize to the
    same name are matched one-to-one in order rather than collapsed.

    `aliases` maps a normalized field name to its alias group. A field only the
    left has and a field only the right has, whose names are in one group, are
    paired into one "possible_match" row at the left field's position, each
    right field used at most once (first come, first paired)."""
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
    leftover = [CompareRow(status=ONLY_RIGHT, name=f["name"], right=f) for index, f in enumerate(right_fields) if index not in used]
    if aliases:
        leftover = _pair_aliases(rows, leftover, aliases)
    rows.extend(leftover)
    return Comparison(rows=rows, left_count=len(left_fields), right_count=len(right_fields))


def _pair_aliases(
    rows: list[CompareRow], leftover: list[CompareRow], aliases: Mapping[str, AliasConcept]
) -> list[CompareRow]:
    """Turn each only-left row that has an alias-group partner among the
    only-right rows into a possible match (in place, keeping its position) and
    return the only-right rows that were not used."""
    remaining = list(leftover)
    for row in rows:
        if row.status != ONLY_LEFT:
            continue
        concept = aliases.get(normalize_name(row.name))
        if concept is None:
            continue
        for candidate in remaining:
            if aliases.get(normalize_name(candidate.name)) == concept:
                remaining.remove(candidate)
                row.status = POSSIBLE_MATCH
                row.right = candidate.right
                row.concept = concept
                row.differences = differing_attributes(row.left, candidate.right)
                break
    return remaining
