"""Field alias groups: sets of field names that mean the same thing under
different wording (proposal-template-comparison.md, phase 2). Kept by hand,
shared by everyone, and only ever read by the template comparison to show a
"possible match" for a person to judge. Nothing here changes a template.
"""
from __future__ import annotations

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models
from app.models import FieldAliasGroup
from app.services.domain_errors import ConflictError, NotFoundError
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


# ---------- alias groups for the API (routers/field_aliases.py) ----------

_JUST_ADDED = "One of those names was just added to another group."


def _describe(group: FieldAliasGroup) -> str:
    return group.label or ", ".join(n.name for n in group.names)


def _check_free(db: Session, names: list[str], exclude_group: uuid.UUID | None = None) -> None:
    """A name belongs to at most one group: refuse a name another group has."""
    query = db.query(models.FieldAliasName).filter(models.FieldAliasName.normalized.in_(normalized_names(names)))
    if exclude_group is not None:
        query = query.filter(models.FieldAliasName.group_id != exclude_group)
    clash = query.first()
    if clash is not None:
        raise ConflictError(f"'{clash.name}' is already in the group '{_describe(clash.group)}'.")


def list_groups(db: Session) -> list[FieldAliasGroup]:
    return db.query(FieldAliasGroup).order_by(FieldAliasGroup.created_at, FieldAliasGroup.id).all()


def create_group(db: Session, label: str | None, names: list[str]) -> FieldAliasGroup:
    _check_free(db, names)
    group = FieldAliasGroup(label=label)
    group.names = [
        models.FieldAliasName(name=n, normalized=normalize_name(n), position=i) for i, n in enumerate(names)
    ]
    db.add(group)
    try:
        db.commit()
    except IntegrityError:
        # Two people adding the same name at once: the unique index decides.
        db.rollback()
        raise ConflictError(_JUST_ADDED)
    db.refresh(group)
    return group


def replace_group(db: Session, group_id: uuid.UUID, label: str | None, names: list[str]) -> FieldAliasGroup:
    group = db.get(FieldAliasGroup, group_id)
    if not group:
        raise NotFoundError("Alias group not found")
    _check_free(db, names, exclude_group=group.id)
    group.label = label
    # The old name rows are deleted outright, then the new ones inserted. Setting
    # `group.names = [...]` instead made SQLAlchemy try to detach the old rows
    # (group_id = NULL, a 500) when the collection had not been loaded yet, and
    # a name kept in the new list would hit the unique index if inserted before
    # its old row was gone.
    db.query(models.FieldAliasName).filter(models.FieldAliasName.group_id == group.id).delete(synchronize_session=False)
    for position, name in enumerate(names):
        db.add(models.FieldAliasName(group_id=group.id, name=name, normalized=normalize_name(name), position=position))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_JUST_ADDED)
    db.refresh(group)
    return group


def delete_group(db: Session, group_id: uuid.UUID) -> None:
    group = db.get(FieldAliasGroup, group_id)
    if not group:
        raise NotFoundError("Alias group not found")
    db.delete(group)
    db.commit()
