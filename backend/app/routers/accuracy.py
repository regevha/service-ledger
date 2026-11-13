"""Reading accuracy and the technical glossary (Admin screen)."""
from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services import glossary
from app.services.read_accuracy import read_accuracy

router = APIRouter(tags=["accuracy"])


@router.get("/analytics/read-accuracy", response_model=schemas.ReadAccuracyOut)
def get_read_accuracy(
    days: int | None = Query(90, ge=0, le=3660, description="Reports finalized in the last N days; leave out for 90, send 0 for all."),
    db: Session = Depends(get_db),
) -> schemas.ReadAccuracyOut:
    """How much of the reading was approved without an edit: the overall share of fields and of reports, by week,
    by field, by form and by source (translated or not), the newest corrections, and the translation edits."""
    return read_accuracy(db, date.today(), days or None)


@router.get("/glossary-terms", response_model=list[schemas.GlossaryTermOut])
def list_glossary_terms(db: Session = Depends(get_db)):
    return glossary.list_terms(db)


@router.post("/glossary-terms", response_model=schemas.GlossaryTermOut, status_code=201)
def create_glossary_term(payload: schemas.GlossaryTermIn, db: Session = Depends(get_db)):
    """Add a term. The next translation is given it, and a wrong wording left in a translation is corrected."""
    return glossary.create_term(db, payload.source_term, payload.wrong_term, payload.english_term, payload.note)


@router.patch("/glossary-terms/{term_id}", response_model=schemas.GlossaryTermOut)
def update_glossary_term(term_id: uuid.UUID, payload: schemas.GlossaryTermPatch, db: Session = Depends(get_db)):
    return glossary.update_term(db, term_id, payload.model_dump(exclude_unset=True))


@router.delete("/glossary-terms/{term_id}", status_code=204)
def delete_glossary_term(term_id: uuid.UUID, db: Session = Depends(get_db)) -> Response:
    glossary.delete_term(db, term_id)
    return Response(status_code=204)
