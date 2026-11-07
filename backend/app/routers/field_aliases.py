"""Field alias groups: a short, hand-kept list of sets of field names that mean
the same thing ("root_cause" and "cause", say), shared by everyone. The
template comparison reads them to show a "possible match"; nothing else does,
and nothing here renames or merges a field (proposal-template-comparison.md,
phase 2)."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services import field_aliases as aliases

router = APIRouter(tags=["field-aliases"])


def _out(group: models.FieldAliasGroup) -> schemas.FieldAliasGroupOut:
    return schemas.FieldAliasGroupOut(
        id=group.id, label=group.label, names=[n.name for n in group.names], created_at=group.created_at
    )


@router.get("/field-aliases", response_model=list[schemas.FieldAliasGroupOut])
def list_field_aliases(db: Session = Depends(get_db)):
    return [_out(g) for g in aliases.list_groups(db)]


@router.post("/field-aliases", response_model=schemas.FieldAliasGroupOut, status_code=201)
def create_field_alias_group(payload: schemas.FieldAliasGroupIn, db: Session = Depends(get_db)):
    return _out(aliases.create_group(db, payload.label, payload.names))


@router.put("/field-aliases/{group_id}", response_model=schemas.FieldAliasGroupOut)
def replace_field_alias_group(group_id: uuid.UUID, payload: schemas.FieldAliasGroupIn, db: Session = Depends(get_db)):
    return _out(aliases.replace_group(db, group_id, payload.label, payload.names))


@router.delete("/field-aliases/{group_id}", status_code=204)
def delete_field_alias_group(group_id: uuid.UUID, db: Session = Depends(get_db)):
    aliases.delete_group(db, group_id)
