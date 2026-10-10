from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.db import get_db
from app.services.analytics import trend_points, trendable_fields
from app.services.report_deletion import count_in_flight_jobs, remove_report_files

router = APIRouter(tags=["instruments"])

_SERIAL_CONFLICT = "An instrument with this serial number already exists"


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


@router.delete("/instruments/{instrument_id}", status_code=204)
def delete_instrument(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    """Permanently delete an instrument together with every report on it —
    drafts and finalized alike, whatever the instrument's status — their
    attachments, extraction jobs and stored scan files. There is no undo and
    no audit trail (§10); the Instruments tab shows the report count and asks
    first.

    The one refusal: if any of the instrument's reports still has a scan
    queued or being read (a pending, classifying or extracting job), the answer
    is 409 — the worker would be writing to rows that are about to disappear.
    Try again once the job finishes."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")
    reports = db.query(models.Report).filter(models.Report.instrument_id == instrument_id).all()
    attachments = [a for r in reports for a in r.attachments]
    if count_in_flight_jobs(db, [a.id for a in attachments]):
        raise HTTPException(409, "A scan for one of this instrument's reports is still being read. Try again in a moment.")
    files = {r.id: [a.file_path for a in r.attachments] for r in reports}
    for report in reports:
        db.delete(report)  # takes its attachments and their jobs with it
    db.delete(instrument)
    try:
        db.commit()
    except IntegrityError:
        # A report was attached to this instrument after the list above was
        # read; the FK stopped the delete (see Instrument.reports).
        db.rollback()
        raise HTTPException(409, "A report was attached to this instrument just now — try again.") from None
    for report_id, paths in files.items():
        remove_report_files(report_id, paths)


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
    return trendable_fields(reports)


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
    points = trend_points(reports, field)
    return schemas.TrendOut(instrument_id=instrument_id, field=field, points=points)
