"""Instrument models as records of their own (models plan, step 2).

The model record is the source: renaming it, or changing its manufacturer,
updates the copies on its instruments (and a rename updates the report
templates written for that model name) in the same transaction. Nothing is
merged unless a person asks for it here.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.maintenance import annotate
from app.services.model_reliability import compute_model_reliability
from app.routers.reports import _list_item
from app.services.instrument_models import near_duplicates
from app.services.instrument_types import type_exists

router = APIRouter(tags=["instrument-models"])

_NAME_CONFLICT = "A model with this name already exists"


def _out(db: Session, record: models.InstrumentModel, similar: dict[str, list[str]] | None = None) -> schemas.InstrumentModelOut:
    units = db.query(models.Instrument).filter(models.Instrument.model_id == record.id).count()
    templates = db.query(models.ReportTemplate).filter(models.ReportTemplate.model == record.name).count()
    return schemas.InstrumentModelOut(
        id=record.id,
        name=record.name,
        manufacturer=record.manufacturer,
        instrument_type=record.instrument_type,
        service_interval_months=record.service_interval_months,
        notes=record.notes,
        unit_count=units,
        template_count=templates,
        similar_to=(similar or {}).get(record.name, []),
    )


def _similar_map(names: list[str]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for group in near_duplicates(names):
        for name in group:
            out[name] = [n for n in group if n != name]
    return out


@router.get("/instrument-models", response_model=list[schemas.InstrumentModelOut])
def list_instrument_models(db: Session = Depends(get_db)):
    records = db.query(models.InstrumentModel).order_by(func.lower(models.InstrumentModel.name)).all()
    similar = _similar_map([r.name for r in records])
    return [_out(db, r, similar) for r in records]


_PAGE_REPORTS = 25


@router.get("/instrument-models/{model_id}", response_model=schemas.InstrumentModelDetailOut)
def get_instrument_model(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """A model's page: the record, each of its instruments with last service
    date and report counts, and its newest reports."""
    record = db.get(models.InstrumentModel, model_id)
    if not record:
        raise HTTPException(404, "Model not found")
    units = (
        db.query(models.Instrument)
        .filter(models.Instrument.model_id == record.id)
        .order_by(models.Instrument.name)
        .all()
    )
    reports = (
        db.query(models.Report)
        .join(models.Instrument, models.Report.instrument_id == models.Instrument.id)
        .filter(models.Instrument.model_id == record.id)
        .order_by(*[t.desc() for t in models.report_chronological_order()])
        .all()
    )
    by_unit: dict[uuid.UUID, list[models.Report]] = {}
    for report in reports:
        by_unit.setdefault(report.instrument_id, []).append(report)

    annotate(db, units)
    unit_rows = []
    for unit in units:
        own = by_unit.get(unit.id, [])
        done = [r for r in own if r.status == models.ReportStatus.finalized]
        days = [r.report_date or r.created_at.date() for r in done]
        unit_rows.append(
            schemas.InstrumentModelUnitOut(
                id=unit.id,
                name=unit.name,
                serial_number=unit.serial_number,
                status=unit.status,
                institution=unit.institution,
                location=unit.location,
                last_service_date=max(days) if days else None,
                report_count=len(done),
                maintenance_due_date=unit.maintenance_due_date,
                maintenance_state=unit.maintenance_state,
                repair_count=sum(1 for r in done if r.template and r.template.report_type == models.ReportType.repair),
                draft_count=len(own) - len(done),
            )
        )
    base = _out(db, record, _similar_map([m.name for m in db.query(models.InstrumentModel).all()]))
    return schemas.InstrumentModelDetailOut(
        **base.model_dump(),
        units=unit_rows,
        reports=[_list_item(r) for r in reports[:_PAGE_REPORTS]],
        report_total=len(reports),
    )


@router.get("/instrument-models/{model_id}/reliability", response_model=schemas.ModelReliabilityOut)
def get_instrument_model_reliability(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """Days between repairs, common fault categories, parts and labor hours for
    a model's instruments (services/model_reliability.py)."""
    if not db.get(models.InstrumentModel, model_id):
        raise HTTPException(404, "Model not found")
    return compute_model_reliability(db, model_id)


@router.post("/instrument-models", response_model=schemas.InstrumentModelOut, status_code=201)
def create_instrument_model(payload: schemas.InstrumentModelCreate, db: Session = Depends(get_db)):
    if not type_exists(db, payload.instrument_type):
        raise HTTPException(422, f"Unknown instrument type '{payload.instrument_type}'. Add it first.")
    if db.query(models.InstrumentModel).filter(models.InstrumentModel.name == payload.name).first():
        raise HTTPException(409, _NAME_CONFLICT)
    record = models.InstrumentModel(**payload.model_dump())
    db.add(record)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _NAME_CONFLICT) from None
    db.refresh(record)
    return _out(db, record)


@router.patch("/instrument-models/{model_id}", response_model=schemas.InstrumentModelOut)
def update_instrument_model(model_id: uuid.UUID, payload: schemas.InstrumentModelUpdate, db: Session = Depends(get_db)):
    record = db.get(models.InstrumentModel, model_id)
    if not record:
        raise HTTPException(404, "Model not found")
    provided = payload.model_fields_set
    for field in ("name", "instrument_type"):
        if field in provided and getattr(payload, field) is None:
            raise HTTPException(422, f"{field} cannot be null — omit it to leave it unchanged.")

    units = db.query(models.Instrument).filter(models.Instrument.model_id == record.id).all()

    if "instrument_type" in provided and payload.instrument_type != record.instrument_type:
        if not type_exists(db, payload.instrument_type):
            raise HTTPException(422, f"Unknown instrument type '{payload.instrument_type}'. Add it first.")
        if units:
            raise HTTPException(
                409,
                f"This model has {len(units)} instrument{'s' if len(units) != 1 else ''}, and an instrument's type cannot "
                "change because its templates and reports are tied to it.",
            )

    old_name = record.name
    renamed = "name" in provided and payload.name != old_name
    if renamed:
        if db.query(models.InstrumentModel).filter(models.InstrumentModel.name == payload.name).first():
            raise HTTPException(409, _NAME_CONFLICT)
        # Templates are matched by model name, so they follow the rename. A
        # template that would collide with one already written for the new
        # name stops it: nothing is renamed halfway.
        templates = db.query(models.ReportTemplate).filter(models.ReportTemplate.model == old_name).all()
        for template in templates:
            clash = (
                db.query(models.ReportTemplate)
                .filter(
                    models.ReportTemplate.instrument_type == template.instrument_type,
                    models.ReportTemplate.report_type == template.report_type,
                    models.ReportTemplate.model == payload.name,
                )
                .first()
            )
            if clash:
                raise HTTPException(
                    409,
                    f"A {template.report_type.value} template already exists for “{payload.name}”. "
                    "Remove or rename one of the two templates first.",
                )
        for template in templates:
            template.model = payload.name
        record.name = payload.name

    for field in ("manufacturer", "instrument_type", "service_interval_months", "notes"):
        if field in provided:
            setattr(record, field, getattr(payload, field))

    # The instruments keep their own copies for now; the model is the source.
    for unit in units:
        if renamed:
            unit.model = record.name
        if "manufacturer" in provided:
            unit.manufacturer = record.manufacturer
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _NAME_CONFLICT) from None
    db.refresh(record)
    return _out(db, record)


@router.delete("/instrument-models/{model_id}", status_code=204)
def delete_instrument_model(model_id: uuid.UUID, db: Session = Depends(get_db)):
    """Removes a model record that no instrument uses. Report templates written
    for the model's name are left alone."""
    record = db.get(models.InstrumentModel, model_id)
    if not record:
        raise HTTPException(404, "Model not found")
    units = db.query(models.Instrument).filter(models.Instrument.model_id == record.id).count()
    if units:
        raise HTTPException(
            409,
            f"{units} instrument{'s' if units != 1 else ''} still use{'' if units != 1 else 's'} this model. "
            "Move them to another model, or merge this model into one.",
        )
    db.delete(record)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An instrument was just added to this model — try again.") from None


@router.post("/instrument-models/{model_id}/merge", response_model=schemas.InstrumentModelMergeOut)
def merge_instrument_model(model_id: uuid.UUID, payload: schemas.InstrumentModelMerge, db: Session = Depends(get_db)):
    """Moves every instrument of this model (and the templates written for its
    name) to another model of the same instrument type, then removes this one.
    Only a person asks for this; the app never merges by guess."""
    source = db.get(models.InstrumentModel, model_id)
    target = db.get(models.InstrumentModel, payload.into_id)
    if not source or not target:
        raise HTTPException(404, "Model not found")
    if source.id == target.id:
        raise HTTPException(422, "Pick a different model to merge into.")
    if source.instrument_type != target.instrument_type:
        raise HTTPException(422, "Only models of the same instrument type can be merged.")

    templates = db.query(models.ReportTemplate).filter(models.ReportTemplate.model == source.name).all()
    for template in templates:
        clash = (
            db.query(models.ReportTemplate)
            .filter(
                models.ReportTemplate.instrument_type == template.instrument_type,
                models.ReportTemplate.report_type == template.report_type,
                models.ReportTemplate.model == target.name,
            )
            .first()
        )
        if clash:
            raise HTTPException(
                409,
                f"Both models have a {template.report_type.value} template. Remove one of them first, then merge.",
            )

    units = db.query(models.Instrument).filter(models.Instrument.model_id == source.id).all()
    for unit in units:
        unit.model_record = target
        unit.model = target.name
        if target.manufacturer is not None:
            unit.manufacturer = target.manufacturer
    for template in templates:
        template.model = target.name
    db.flush()
    db.delete(source)
    db.commit()
    return schemas.InstrumentModelMergeOut(moved_instruments=len(units), moved_templates=len(templates), into=target.name)
