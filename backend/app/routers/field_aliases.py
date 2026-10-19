"""Field alias groups: a short, hand-kept list of sets of field names that mean
the same thing ("retest_result", "verification_result"), shared by everyone. The
template comparison reads them to show a "possible match"; nothing else does,
and nothing here renames or merges a field (proposal-template-comparison.md,
phase 2)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.template_compare import normalize_name

router = APIRouter(tags=["field-aliases"])


def _out(group: models.FieldAliasGroup) -> schemas.FieldAliasGroupOut:
    return schemas.FieldAliasGroupOut(
        id=group.id, label=group.label, names=[n.name for n in group.names], created_at=group.created_at
    )


def _describe(group: models.FieldAliasGroup) -> str:
    return group.label or ", ".join(n.name for n in group.names)


def _check_free(db: Session, names: list[str], exclude_group: uuid.UUID | None = None) -> None:
    """A name belongs to at most one group: refuse a name another group has."""
    query = db.query(models.FieldAliasName).filter(models.FieldAliasName.normalized.in_([normalize_name(n) for n in names]))
    if exclude_group is not None:
        query = query.filter(models.FieldAliasName.group_id != exclude_group)
    clash = query.first()
    if clash is not None:
        raise HTTPException(409, f"'{clash.name}' is already in the group '{_describe(clash.group)}'.")


def _set_names(group: models.FieldAliasGroup, names: list[str]) -> None:
    group.names = [
        models.FieldAliasName(name=n, normalized=normalize_name(n), position=i) for i, n in enumerate(names)
    ]


@router.get("/field-aliases", response_model=list[schemas.FieldAliasGroupOut])
def list_field_aliases(db: Session = Depends(get_db)):
    groups = db.query(models.FieldAliasGroup).order_by(models.FieldAliasGroup.created_at, models.FieldAliasGroup.id).all()
    return [_out(g) for g in groups]


@router.post("/field-aliases", response_model=schemas.FieldAliasGroupOut, status_code=201)
def create_field_alias_group(payload: schemas.FieldAliasGroupIn, db: Session = Depends(get_db)):
    _check_free(db, payload.names)
    group = models.FieldAliasGroup(label=payload.label)
    _set_names(group, payload.names)
    db.add(group)
    try:
        db.commit()
    except IntegrityError:
        # Two people adding the same name at once: the unique index decides.
        db.rollback()
        raise HTTPException(409, "One of those names was just added to another group.")
    db.refresh(group)
    return _out(group)


@router.put("/field-aliases/{group_id}", response_model=schemas.FieldAliasGroupOut)
def replace_field_alias_group(group_id: uuid.UUID, payload: schemas.FieldAliasGroupIn, db: Session = Depends(get_db)):
    group = db.get(models.FieldAliasGroup, group_id)
    if not group:
        raise HTTPException(404, "Alias group not found")
    _check_free(db, payload.names, exclude_group=group.id)
    group.label = payload.label
    # The old name rows are deleted outright, then the new ones inserted. Setting
    # `group.names = [...]` instead made SQLAlchemy try to detach the old rows
    # (group_id = NULL, a 500) when the collection had not been loaded yet, and
    # a name kept in the new list would hit the unique index if inserted before
    # its old row was gone.
    db.query(models.FieldAliasName).filter(models.FieldAliasName.group_id == group.id).delete(synchronize_session=False)
    for position, name in enumerate(payload.names):
        db.add(models.FieldAliasName(group_id=group.id, name=name, normalized=normalize_name(name), position=position))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "One of those names was just added to another group.")
    db.refresh(group)
    return _out(group)


@router.delete("/field-aliases/{group_id}", status_code=204)
def delete_field_alias_group(group_id: uuid.UUID, db: Session = Depends(get_db)):
    group = db.get(models.FieldAliasGroup, group_id)
    if not group:
        raise HTTPException(404, "Alias group not found")
    db.delete(group)
    db.commit()
