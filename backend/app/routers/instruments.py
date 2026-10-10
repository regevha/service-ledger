from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.db import get_db

router = APIRouter(tags=["instruments"])

_SERIAL_CONFLICT = "An instrument with this serial number already exists"

# field_schema's three numeric-capable types (schemas.py::TemplateFieldType)
# — the only ones GET .../trend-fields offers and GET .../trend can chart.
# A flat "number" contributes one point per report; the other two contribute
# a {key: value} map per report (one entry per detector/laser).
_TREND_MAP_TYPES = {schemas.TemplateFieldType.number_detector, schemas.TemplateFieldType.number_laser}
_TRENDABLE_TYPES = {schemas.TemplateFieldType.number, *_TREND_MAP_TYPES}


@router.post("/instruments", response_model=schemas.InstrumentOut, status_code=201)
def create_instrument(payload: schemas.InstrumentCreate, db: Session = Depends(get_db)):
    if db.query(models.Instrument).filter(models.Instrument.serial_number == payload.serial_number).first():
        raise HTTPException(409, _SERIAL_CONFLICT)
    instrument = models.Instrument(**payload.model_dump())
    db.add(instrument)
    try:
        db.commit()
    except IntegrityError:
        # Closes the race window between the pre-check above and the
        # commit (two concurrent POSTs for the same serial number) — the
        # DB's own unique constraint (models.py's Instrument.serial_number)
        # is what actually stops the duplicate, this just turns the
        # resulting IntegrityError into the same clean 409 as the pre-check.
        db.rollback()
        raise HTTPException(409, _SERIAL_CONFLICT)
    db.refresh(instrument)
    return instrument


@router.get("/instruments", response_model=list[schemas.InstrumentOut])
def list_instruments(db: Session = Depends(get_db)):
    return db.query(models.Instrument).order_by(models.Instrument.name).all()


@router.get("/instruments/{instrument_id}", response_model=schemas.InstrumentOut)
def get_instrument(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")
    return instrument


@router.patch("/instruments/{instrument_id}", response_model=schemas.InstrumentOut)
def update_instrument(instrument_id: uuid.UUID, payload: schemas.InstrumentUpdate, db: Session = Depends(get_db)):
    """Every field but `instrument_type` is editable — the create/edit UI
    this backs (frontend's new Instruments tab) replaces "edit the DB/seed
    script by hand" as the only way to fix a typo'd serial number, rename an
    instrument, move it to a new bench, or change its status once §5's fixed
    3-instrument fleet stops being fixed in practice."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")

    # model_fields_set, not model_dump(exclude_unset=True) directly, so an
    # explicit null on one of these NOT NULL columns is caught below instead
    # of silently no-op'ing (InstrumentUpdate's fields all default to None,
    # so "not sent" and "sent as null" would otherwise look identical).
    provided = payload.model_fields_set
    for field in ("name", "model", "serial_number", "status"):
        if field in provided and getattr(payload, field) is None:
            raise HTTPException(422, f"{field} cannot be null — omit it to leave it unchanged.")

    if "serial_number" in provided and payload.serial_number != instrument.serial_number:
        conflict = (
            db.query(models.Instrument)
            .filter(models.Instrument.serial_number == payload.serial_number, models.Instrument.id != instrument.id)
            .first()
        )
        if conflict:
            raise HTTPException(409, _SERIAL_CONFLICT)

    for field in ("name", "model", "serial_number", "location", "status"):
        if field in provided:
            setattr(instrument, field, getattr(payload, field))

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _SERIAL_CONFLICT)
    db.refresh(instrument)
    return instrument


@router.get("/instruments/{instrument_id}/trend-fields", response_model=list[schemas.TrendFieldOut])
def instrument_trend_fields(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    """Which fields GET .../trend can actually chart for this instrument —
    derived from the real templates its own finalized reports resolved to,
    not a hardcoded list, so a new template's numeric fields show up here
    automatically and a technically-possible-but-never-used field never
    shows up as a dead end. Backs the instrument detail page's field picker
    (docs/instrument-timeline-demo.html's mockup skipped this entirely — it
    hardcoded one field for one instrument)."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")

    reports = (
        db.query(models.Report)
        .options(joinedload(models.Report.template))
        .filter(
            models.Report.instrument_id == instrument_id,
            models.Report.status == models.ReportStatus.finalized,
            models.Report.template_id.isnot(None),
        )
        .all()
    )
    fields: dict[str, schemas.TrendFieldOut] = {}
    for report in reports:
        if not report.template:
            continue
        for f in report.template.field_schema.get("fields", []):
            if f["type"] in _TRENDABLE_TYPES and f["name"] not in fields:
                fields[f["name"]] = schemas.TrendFieldOut(name=f["name"], type=f["type"], unit=f.get("unit"))
    return sorted(fields.values(), key=lambda f: f.name)


@router.get("/instruments/{instrument_id}/trend", response_model=schemas.TrendOut)
def instrument_trend(
    instrument_id: uuid.UUID,
    field: str = Query(..., description="Key inside extracted_fields to trend, e.g. baseline_cv_percent"),
    db: Session = Depends(get_db),
):
    """§7/§9: time series for one field, one instrument — a plain number per
    point for a flat "number" field, or a {key: value} map per point (one
    entry per detector/laser) for a number[detector]/number[laser] field.
    Only reports that actually have that key in extracted_fields, as a real
    number or a dict containing at least one real number, contribute a
    point — a calibration-only field on a repair-heavy instrument just
    yields a short series, not an error."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")

    reports = (
        db.query(models.Report)
        .filter(models.Report.instrument_id == instrument_id, models.Report.status == models.ReportStatus.finalized)
        .order_by(*models.report_chronological_order())
        .all()
    )
    points: list[schemas.TrendPointOut] = []
    for report in reports:
        value = report.extracted_fields.get(field) if report.extracted_fields else None
        # bool is a subclass of int in Python — services/analytics.py's
        # _as_number hits the same trap and excludes it the same way, so a
        # stray True/False extracted for a numeric-typed field doesn't show
        # up disguised as 0/1.
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            points.append(schemas.TrendPointOut(report_id=report.id, report_date=report.report_date, value=float(value)))
        elif isinstance(value, dict):
            numeric = {k: float(v) for k, v in value.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
            if numeric:
                points.append(schemas.TrendPointOut(report_id=report.id, report_date=report.report_date, value=numeric))
    return schemas.TrendOut(instrument_id=instrument_id, field=field, points=points)
