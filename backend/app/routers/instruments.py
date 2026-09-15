from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db

router = APIRouter(tags=["instruments"])


@router.post("/instruments", response_model=schemas.InstrumentOut, status_code=201)
def create_instrument(payload: schemas.InstrumentCreate, db: Session = Depends(get_db)):
    if db.query(models.Instrument).filter(models.Instrument.serial_number == payload.serial_number).first():
        raise HTTPException(409, "An instrument with this serial number already exists")
    instrument = models.Instrument(**payload.model_dump())
    db.add(instrument)
    db.commit()
    db.refresh(instrument)
    return instrument


@router.get("/instruments", response_model=list[schemas.InstrumentOut])
def list_instruments(db: Session = Depends(get_db)):
    return db.query(models.Instrument).order_by(models.Instrument.name).all()


@router.get("/instruments/{instrument_id}/trend")
def instrument_trend(
    instrument_id: uuid.UUID,
    field: str = Query(..., description="Key inside extracted_fields to trend, e.g. baseline_cv_percent"),
    db: Session = Depends(get_db),
):
    """§7/§9: time series for one field, one instrument. Only reports that
    actually have that key in extracted_fields (as a plain number) contribute
    a point — a calibration-only field on a repair-heavy instrument just
    yields a short series, not an error."""
    instrument = db.get(models.Instrument, instrument_id)
    if not instrument:
        raise HTTPException(404, "Instrument not found")

    reports = (
        db.query(models.Report)
        .filter(models.Report.instrument_id == instrument_id, models.Report.status == models.ReportStatus.finalized)
        .order_by(models.Report.report_date)
        .all()
    )
    points = []
    for report in reports:
        value = report.extracted_fields.get(field) if report.extracted_fields else None
        if isinstance(value, (int, float)):
            points.append({"report_id": report.id, "report_date": report.report_date, "value": value})
    return {"instrument_id": instrument_id, "field": field, "points": points}
