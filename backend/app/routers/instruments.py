from __future__ import annotations

import uuid
from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services import instruments as svc
from app.services.analytics import trend_points, trendable_fields

router = APIRouter(tags=["instruments"])


@router.post("/instruments", response_model=schemas.InstrumentOut, status_code=201)
def create_instrument(payload: schemas.InstrumentCreate, db: Session = Depends(get_db)):
    return svc.create_instrument(db, payload)


@router.get("/instruments", response_model=list[schemas.InstrumentOut])
def list_instruments(db: Session = Depends(get_db)):
    return svc.list_instruments(db)


@router.get("/instruments/repair-counts", response_model=list[schemas.RepairCountOut])
def instrument_repair_counts(
    date_from: date | None = Query(None, description="Count repairs dated on or after this day"),
    date_to: date | None = Query(None, description="Count repairs dated on or before this day"),
    db: Session = Depends(get_db),
):
    """How many finalized repair reports each instrument has in the date range (every instrument is listed, with 0
    when it has none). Drafts and reports still being checked are left out, because their values can still change."""
    from sqlalchemy import func  # noqa: PLC0415

    from app.services.report_filters import apply_report_filters  # noqa: PLC0415

    counted = apply_report_filters(
        db.query(models.Report.instrument_id, func.count(models.Report.id)),
        report_type=models.ReportType.repair,
        status=models.ReportStatus.finalized,
        date_from=date_from,
        date_to=date_to,
    ).group_by(models.Report.instrument_id)
    counts = {instrument_id: n for instrument_id, n in counted}
    return [{"instrument_id": i.id, "repairs": counts.get(i.id, 0)} for i in db.query(models.Instrument).all()]


@router.get("/instruments/{instrument_id}", response_model=schemas.InstrumentOut)
def get_instrument(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    return svc.get_annotated_instrument(db, instrument_id)


@router.patch("/instruments/{instrument_id}", response_model=schemas.InstrumentOut)
def update_instrument(instrument_id: uuid.UUID, payload: schemas.InstrumentUpdate, db: Session = Depends(get_db)):
    """Every field but `instrument_type` is editable — the create/edit UI
    this backs (frontend's new Instruments tab) replaces "edit the DB/seed
    script by hand" as the only way to fix a typo'd serial number, rename an
    instrument, move it to a new room, or change its status once §5's fixed
    3-instrument fleet stops being fixed in practice."""
    return svc.update_instrument(db, instrument_id, payload)


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
    svc.delete_instrument(db, instrument_id)


@router.get("/instruments/{instrument_id}/trend-fields", response_model=list[schemas.TrendFieldOut])
def instrument_trend_fields(instrument_id: uuid.UUID, db: Session = Depends(get_db)):
    """Which fields GET .../trend can actually chart for this instrument —
    derived from the real templates its own finalized reports resolved to,
    not a hardcoded list, so a new template's numeric fields show up here
    automatically and a technically-possible-but-never-used field never
    shows up as a dead end. Backs the instrument detail page's field picker
    (docs/instrument-timeline-demo.html's mockup skipped this entirely — it
    hardcoded one field for one instrument)."""
    return trendable_fields(svc.finalized_reports_with_templates(db, instrument_id))


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
    point — a field only some report types carry on a repair-heavy instrument just
    yields a short series, not an error."""
    points = trend_points(svc.finalized_reports_in_order(db, instrument_id), field)
    return schemas.TrendOut(instrument_id=instrument_id, field=field, points=points)
