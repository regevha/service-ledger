from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.manufacturers import clean, matches, normalize

router = APIRouter(tags=["manufacturers"])

_CONFLICT = "Another maker already has this name or alias"


def _out(db: Session, maker: models.Manufacturer) -> schemas.ManufacturerOut:
    out = schemas.ManufacturerOut.model_validate(maker)
    out.instrument_count = db.query(func.count(models.Instrument.id)).filter(models.Instrument.manufacturer_id == maker.id).scalar() or 0
    out.model_count = db.query(func.count(models.InstrumentModel.id)).filter(models.InstrumentModel.manufacturer_id == maker.id).scalar() or 0
    return out


def _spellings(name: str, aliases: list[str]) -> tuple[str, list[str]]:
    """Trimmed name and aliases: blanks, repeats and the name itself dropped."""
    name = clean(name) or ""
    if not normalize(name):
        raise HTTPException(422, "The maker needs a name with at least one letter or digit")
    kept: list[str] = []
    seen = {normalize(name)}
    for alias in aliases:
        alias = clean(alias)
        if alias and normalize(alias) and normalize(alias) not in seen:
            seen.add(normalize(alias))
            kept.append(alias)
    return name, kept


def _clash(db: Session, name: str, aliases: list[str], own_id: uuid.UUID | None) -> bool:
    """True when another maker already answers to the name or to one of the aliases."""
    others = db.query(models.Manufacturer).filter(models.Manufacturer.id != own_id).all() if own_id else db.query(models.Manufacturer).all()
    return any(matches(other, text) for other in others for text in (name, *aliases))


@router.get("/manufacturers", response_model=list[schemas.ManufacturerOut])
def list_manufacturers(db: Session = Depends(get_db)):
    makers = db.query(models.Manufacturer).order_by(func.lower(models.Manufacturer.name)).all()
    return [_out(db, m) for m in makers]


@router.post("/manufacturers", response_model=schemas.ManufacturerOut, status_code=201)
def create_manufacturer(payload: schemas.ManufacturerCreate, db: Session = Depends(get_db)):
    name, aliases = _spellings(payload.name, payload.aliases)
    if _clash(db, name, aliases, None):
        raise HTTPException(409, _CONFLICT)
    maker = models.Manufacturer(name=name, aliases=aliases)
    db.add(maker)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _CONFLICT)
    db.refresh(maker)
    return _out(db, maker)


@router.patch("/manufacturers/{maker_id}", response_model=schemas.ManufacturerOut)
def update_manufacturer(maker_id: uuid.UUID, payload: schemas.ManufacturerUpdate, db: Session = Depends(get_db)):
    """Renames a maker and/or replaces its aliases. A rename is copied onto the
    instruments and models that point at it, so their text keeps matching. Two makers
    are never merged here: a name or alias another maker answers to is refused (409)."""
    maker = db.get(models.Manufacturer, maker_id)
    if not maker:
        raise HTTPException(404, "Maker not found")
    provided = payload.model_fields_set
    name, aliases = _spellings(
        payload.name if "name" in provided and payload.name is not None else maker.name,
        payload.aliases if "aliases" in provided and payload.aliases is not None else maker.aliases,
    )
    if _clash(db, name, aliases, maker.id):
        raise HTTPException(409, _CONFLICT)
    renamed = name != maker.name
    maker.name = name
    maker.aliases = aliases
    if renamed:
        for table in (models.Instrument, models.InstrumentModel):
            db.execute(update(table).where(table.manufacturer_id == maker.id).values(manufacturer=name))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _CONFLICT)
    db.refresh(maker)
    return _out(db, maker)


@router.delete("/manufacturers/{maker_id}", status_code=204)
def delete_manufacturer(maker_id: uuid.UUID, db: Session = Depends(get_db)):
    maker = db.get(models.Manufacturer, maker_id)
    if not maker:
        raise HTTPException(404, "Maker not found")
    out = _out(db, maker)
    if out.instrument_count or out.model_count:
        raise HTTPException(409, "This maker is still used by instruments or models; change those first")
    db.delete(maker)
    db.commit()
