"""Places as records you can manage (places plan, step 2).

The place record is the source: renaming it, or moving it, updates the
institution and room text on the instruments in it in the same transaction.
Nothing is merged unless a person asks for it here. Kinds nest: an institution
has no parent; a faculty sits in an institution; a room sits in an institution
or a faculty.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services import places as svc

router = APIRouter(tags=["places"])


@router.get("/places", response_model=list[schemas.PlaceOut])
def list_places(db: Session = Depends(get_db)):
    return svc.all_places(db)


@router.post("/places", response_model=schemas.PlaceOut, status_code=201)
def create_place(payload: schemas.PlaceCreate, db: Session = Depends(get_db)):
    return svc.create_place(db, payload)


@router.patch("/places/{place_id}", response_model=schemas.PlaceOut)
def update_place(place_id: uuid.UUID, payload: schemas.PlaceUpdate, db: Session = Depends(get_db)):
    return svc.update_place(db, place_id, payload)


@router.delete("/places/{place_id}", status_code=204)
def delete_place(place_id: uuid.UUID, db: Session = Depends(get_db)):
    """Removes a place that nothing is in and no instrument points at."""
    svc.delete_place(db, place_id)


@router.post("/places/{place_id}/merge", response_model=schemas.PlaceMergeOut)
def merge_place(place_id: uuid.UUID, payload: schemas.PlaceMerge, db: Session = Depends(get_db)):
    """Moves the instruments pointing at this place, and the places inside it, to
    another place of the same kind, then removes this one. Only a person asks for
    this; the app never merges by guess. Refuses when both places have an inside
    place of the same name: merge those first."""
    return svc.merge_place(db, place_id, payload)
