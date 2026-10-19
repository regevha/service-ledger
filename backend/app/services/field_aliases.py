"""Field alias groups: sets of field names that mean the same thing under
different wording (proposal-template-comparison.md, phase 2). Kept by hand,
shared by everyone, and only ever read by the template comparison to show a
"possible match" for a person to judge. Nothing here changes a template.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import FieldAliasGroup
from app.services.template_compare import AliasConcept, normalize_name


def concept_of(group: FieldAliasGroup) -> AliasConcept:
    return AliasConcept(id=group.id, label=group.label, names=tuple(n.name for n in group.names))


def load_alias_index(db: Session) -> dict[str, AliasConcept]:
    """Every alias name (normalized) mapped to its group. A name is in at most
    one group (a unique index), so the mapping is unambiguous."""
    index: dict[str, AliasConcept] = {}
    for group in db.query(FieldAliasGroup).all():
        concept = concept_of(group)
        for member in group.names:
            index[member.normalized] = concept
    return index


def normalized_names(names: list[str]) -> list[str]:
    return [normalize_name(n) for n in names]
