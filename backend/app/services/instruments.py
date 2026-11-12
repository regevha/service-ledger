"""Instruments for the API: create, edit, delete and the report queries behind the
trend endpoints. The router (routers/instruments.py) only translates HTTP; a request
this module has to refuse raises NotFoundError, ConflictError or InvalidError."""
from __future__ import annotations

import uuid

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.services.domain_errors import ConflictError, InvalidError, NotFoundError
from app.services.instrument_models import lock_manufacturer, type_conflict
from app.services.instrument_types import type_exists
from app.services.maintenance import annotate
from app.services.report_deletion import count_in_flight_jobs, remove_report_files

_SERIAL_CONFLICT = "An instrument with this serial number already exists"


def create_instrument(db: Session, payload: schemas.InstrumentCreate) -> models.Instrument:
    if not type_exists(db, payload.instrument_type):
        raise InvalidError(f"Unknown instrument type '{payload.instrument_type}'. Add it first.")
    if db.query(models.Instrument).filter(models.Instrument.serial_number == payload.serial_number).first():
        raise ConflictError(_SERIAL_CONFLICT)
    conflict = type_conflict(db, payload.model, payload.instrument_type)
    if conflict:
        raise InvalidError(conflict)
    instrument = models.Instrument(**payload.model_dump())
    lock_manufacturer(db, instrument)
    db.add(instrument)
    try:
        db.commit()
    except IntegrityError:
        # Closes the race window between the pre-check above and the
        # commit (two concurrent POSTs for the same serial number) — the
        # DB's own unique constraint (models.py's Instrument.serial_number)
        # is what actually stops the duplicate, this just turns the
        # resulting IntegrityError into the same clean refusal as the pre-check.
        db.rollback()
        raise ConflictError(_SERIAL_CONFLICT) from None
    db.refresh(instrument)
    annotate(db, [instrument])
    return instrument


def list_instruments(db: Session) -> list[models.Instrument]:
    instruments = db.query(models.Instrument).options(joinedload(models.Instrument.model_record)).order_by(models.Instrument.name).all()
    annotate(db, instruments)
    return instruments


def get_instrument(db: Session, instrument_id: uuid.UUID) -> models.Instrument:
    """The instrument, or NotFoundError. Not annotated with its maintenance state."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise NotFoundError("Instrument not found")
    return instrument


def get_annotated_instrument(db: Session, instrument_id: uuid.UUID) -> models.Instrument:
    instrument = get_instrument(db, instrument_id)
    annotate(db, [instrument])
    return instrument


def update_instrument(db: Session, instrument_id: uuid.UUID, payload: schemas.InstrumentUpdate) -> models.Instrument:
    instrument = get_instrument(db, instrument_id)

    # model_fields_set, not model_dump(exclude_unset=True) directly, so an
    # explicit null on one of these NOT NULL columns is caught below instead
    # of silently no-op'ing (InstrumentUpdate's fields all default to None,
    # so "not sent" and "sent as null" would otherwise look identical).
    provided = payload.model_fields_set
    for field in ("name", "model", "serial_number", "status"):
        if field in provided and getattr(payload, field) is None:
            raise InvalidError(f"{field} cannot be null — omit it to leave it unchanged.")

    if "serial_number" in provided and payload.serial_number != instrument.serial_number:
        conflict = (
            db.query(models.Instrument)
            .filter(models.Instrument.serial_number == payload.serial_number, models.Instrument.id != instrument.id)
            .first()
        )
        if conflict:
            raise ConflictError(_SERIAL_CONFLICT)

    if "model" in provided and payload.model != instrument.model:
        conflict = type_conflict(db, payload.model, instrument.instrument_type)
        if conflict:
            raise InvalidError(conflict)

    for field in ("name", "model", "manufacturer", "distributor", "institution", "serial_number", "location", "status"):
        if field in provided:
            setattr(instrument, field, getattr(payload, field))
    lock_manufacturer(db, instrument)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_SERIAL_CONFLICT) from None
    db.refresh(instrument)
    annotate(db, [instrument])
    return instrument


def delete_instrument(db: Session, instrument_id: uuid.UUID) -> None:
    """Permanently deletes an instrument with every report on it, their attachments,
    extraction jobs and stored scan files. Refused while a scan of one of its reports
    is still queued or being read."""
    instrument = get_instrument(db, instrument_id)
    reports = db.query(models.Report).filter(models.Report.instrument_id == instrument_id).all()
    attachments = [a for r in reports for a in r.attachments]
    if count_in_flight_jobs(db, [a.id for a in attachments]):
        raise ConflictError("A scan for one of this instrument's reports is still being read. Try again in a moment.")
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
        raise ConflictError("A report was attached to this instrument just now — try again.") from None
    for report_id, paths in files.items():
        remove_report_files(report_id, paths)


def finalized_reports_with_templates(db: Session, instrument_id: uuid.UUID) -> list[models.Report]:
    """Finalized reports of an instrument that resolved to a template (for the trend field picker)."""
    get_instrument(db, instrument_id)
    return (
        db.query(models.Report)
        .options(joinedload(models.Report.template))
        .filter(
            models.Report.instrument_id == instrument_id,
            models.Report.status == models.ReportStatus.finalized,
            models.Report.template_id.isnot(None),
        )
        .all()
    )


def finalized_reports_in_order(db: Session, instrument_id: uuid.UUID) -> list[models.Report]:
    """Finalized reports of an instrument, oldest visit first (for a trend series)."""
    get_instrument(db, instrument_id)
    return (
        db.query(models.Report)
        .filter(models.Report.instrument_id == instrument_id, models.Report.status == models.ReportStatus.finalized)
        .order_by(*models.report_chronological_order())
        .all()
    )
