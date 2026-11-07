"""Instrument models as records of their own (models plan, step 2).

The model record is the source: renaming it, or changing its manufacturer,
updates the copies on its instruments (and a rename updates the report
templates written for that model name) in the same transaction. Nothing is
merged unless a person asks for it here.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services import model_records as svc

router = APIRouter(tags=["instrument-models"])


@router.get("/instrument-models", response_model=list[schemas.InstrumentModelOut])
def list_instrument_models(db: Session = Depends(get_db)):
    return svc.list_models(db)


@router.get("/instrument-models/{model_id}", response_model=schemas.InstrumentModelDetailOut)
def get_instrument_model(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """A model's page: the record, each of its instruments with last service
    date and report counts, and its newest reports."""
    return svc.model_detail(db, model_id)


@router.get("/instrument-models/{model_id}/reliability", response_model=schemas.ModelReliabilityOut)
def get_instrument_model_reliability(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """Days between repairs, common fault categories, parts and labor hours for
    a model's instruments (services/model_reliability.py)."""
    return svc.model_reliability(db, model_id)


@router.post("/instrument-models", response_model=schemas.InstrumentModelOut, status_code=201)
def create_instrument_model(payload: schemas.InstrumentModelCreate, db: Session = Depends(get_db)):
    return svc.create_model(db, payload)


@router.patch("/instrument-models/{model_id}", response_model=schemas.InstrumentModelOut)
def update_instrument_model(model_id: uuid.UUID, payload: schemas.InstrumentModelUpdate, db: Session = Depends(get_db)):
    return svc.update_model(db, model_id, payload)


@router.delete("/instrument-models/{model_id}", status_code=204)
def delete_instrument_model(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """Removes a model record that no instrument uses. Report templates written
    for the model's name are left alone."""
    svc.delete_model(db, model_id)


@router.post("/instrument-models/{model_id}/merge", response_model=schemas.InstrumentModelMergeOut)
def merge_instrument_model(model_id: uuid.UUID, payload: schemas.InstrumentModelMerge, db: Session = Depends(get_db)):
    """Moves every instrument of this model (and the templates written for its
    name) to another model of the same instrument type, then removes this one.
    Only a person asks for this; the app never merges by guess."""
    return svc.merge_model(db, model_id, payload)
