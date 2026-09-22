from __future__ import annotations

import csv
import io
import json
import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db

router = APIRouter(tags=["reports"])


@router.post("/reports", response_model=schemas.ReportOut, status_code=201)
def create_report(payload: schemas.ReportCreate, db: Session = Depends(get_db)):
    """§9: start a bare draft — no instrument or template yet. Document-first
    intake (§4) resolves both after classification."""
    report = models.Report(**payload.model_dump())
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


@router.get("/reports", response_model=list[schemas.ReportListItemOut])
def search_reports(
    instrument_id: uuid.UUID | None = None,
    report_type: models.ReportType | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: models.ReportStatus | None = None,
    technician: str | None = None,
    db: Session = Depends(get_db),
):
    """§7/§9: filtered search — the browse/list view, not a single report's
    detail (that's GET /reports/{id}, still the raw ReportOut shape the
    review flow round-trips against). Returns the denormalized
    ReportListItemOut shape so a list screen can render instrument/report
    type without a lookup per row, the same relationships export_reports
    already reads.

    `technician` is a case-insensitive partial match (ILIKE), not equality
    like the other filters — unlike instrument/report type/status, which
    come from a fixed dropdown, `technician_name` is free text a technician
    typed on intake (§4), so "smith" should find "Jane Smith" without the
    caller needing the exact stored casing/spelling."""
    query = db.query(models.Report)
    if instrument_id:
        query = query.filter(models.Report.instrument_id == instrument_id)
    if report_type:
        query = query.join(models.ReportTemplate).filter(models.ReportTemplate.report_type == report_type)
    if date_from:
        query = query.filter(models.Report.report_date >= date_from)
    if date_to:
        query = query.filter(models.Report.report_date <= date_to)
    if status:
        query = query.filter(models.Report.status == status)
    if technician:
        query = query.filter(models.Report.technician_name.ilike(f"%{technician}%"))
    reports = query.order_by(models.Report.created_at.desc()).all()
    return [
        schemas.ReportListItemOut(
            id=r.id,
            status=r.status,
            instrument_model=r.instrument.model if r.instrument else None,
            instrument_serial_number=r.instrument.serial_number if r.instrument else None,
            report_type=r.template.report_type if r.template else None,
            technician_name=r.technician_name,
            report_date=r.report_date,
            created_at=r.created_at,
            finalized_at=r.finalized_at,
        )
        for r in reports
    ]


@router.get("/reports/export")
def export_reports(
    instrument_id: uuid.UUID | None = None,
    report_type: models.ReportType | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    status: models.ReportStatus | None = None,
    technician: str | None = None,
    db: Session = Depends(get_db),
):
    """§7/§9: bulk CSV export of a filtered view — the same filter set as
    search_reports above, so exporting always matches what's on screen in the
    reports list/search (technician included, same ILIKE partial match — see
    that function's docstring). extracted_fields is flattened to a JSON
    string column rather than one column per possible field — the whole
    point of JSONB (§5) is that the field set varies by template, so a fixed
    CSV schema would defeat it."""
    query = db.query(models.Report)
    if instrument_id:
        query = query.filter(models.Report.instrument_id == instrument_id)
    if report_type:
        query = query.join(models.ReportTemplate).filter(models.ReportTemplate.report_type == report_type)
    if date_from:
        query = query.filter(models.Report.report_date >= date_from)
    if date_to:
        query = query.filter(models.Report.report_date <= date_to)
    if status:
        query = query.filter(models.Report.status == status)
    if technician:
        query = query.filter(models.Report.technician_name.ilike(f"%{technician}%"))
    reports = query.order_by(models.Report.report_date).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "id",
            "status",
            "instrument_model",
            "instrument_serial",
            "report_type",
            "technician_name",
            "report_date",
            "finalized_at",
            "extracted_fields_json",
        ]
    )
    for report in reports:
        writer.writerow(
            [
                report.id,
                report.status.value,
                report.instrument.model if report.instrument else "",
                report.instrument.serial_number if report.instrument else "",
                report.template.report_type.value if report.template else "",
                report.technician_name or "",
                report.report_date.isoformat() if report.report_date else "",
                report.finalized_at.isoformat() if report.finalized_at else "",
                # json.dumps, not str() — str() on a dict produces Python
                # repr syntax (True/None/single-quoted strings), which looks
                # like JSON but isn't: json.loads() on it throws for any
                # report with a boolean, null, or nested field (e.g.
                # CST_CALIBRATION_FIELDS' compensation_matrix_updated), even
                # though this column is named/documented as JSON. default=str
                # is a defensive backstop, not a real dependency — every
                # value here already comes from JSON-schema-typed fields
                # (services/extraction.py), so nothing should ever hit it.
                json.dumps(report.extracted_fields or {}, default=str),
            ]
        )
    buffer.seek(0)
    return StreamingResponse(
        buffer,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=reports_export.csv"},
    )


@router.get("/reports/{report_id}", response_model=schemas.ReportOut)
def get_report(report_id: uuid.UUID, db: Session = Depends(get_db)):
    report = db.get(models.Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    return report


@router.patch("/reports/{report_id}/template", response_model=schemas.ReportOut)
def confirm_template(report_id: uuid.UUID, payload: schemas.TemplateConfirmation, db: Session = Depends(get_db)):
    """§9: confirm or override the classified instrument/template. An
    override (or the manual fallback pick, when classify was uncertain)
    invalidates any extraction already run — §4/§6: values extracted under
    the wrong template aren't corrections to make, they're noise to discard."""
    report = db.get(models.Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    instrument = db.get(models.Instrument, payload.instrument_id)
    template = db.get(models.ReportTemplate, payload.template_id)
    if not instrument or not template:
        raise HTTPException(422, "instrument_id or template_id does not exist")

    template_changed = report.template_id != payload.template_id
    report.instrument_id = payload.instrument_id
    report.template_id = payload.template_id
    report.status = models.ReportStatus.classified
    if template_changed:
        # Discard any prior extraction — it ran (or would run) against the
        # wrong schema.
        report.extracted_fields = {}
    db.commit()
    db.refresh(report)
    return report


@router.patch("/reports/{report_id}/fields", response_model=schemas.ReportOut)
def update_report_fields(report_id: uuid.UUID, payload: schemas.ReportFieldsUpdate, db: Session = Depends(get_db)):
    """§9/§6: apply corrections directly to the report's fields — overwrites
    in place, no audit log in MVP (§10). Allowed even on a finalized report
    (§6: "editing a finalized report ... overwrites its fields in place")."""
    report = db.get(models.Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")

    data = payload.model_dump(exclude_unset=True)
    if "extracted_fields" in data:
        incoming = data.pop("extracted_fields")
        if incoming is None:
            # extracted_fields is a merge overlay (below) onto a NOT NULL
            # column (§5's Report.extracted_fields) — an explicit null has no
            # sensible merge semantics (it isn't "clear all fields", it's
            # "no value"). This used to fall through the old `is not None`
            # guard and reach the generic setattr loop below, writing NULL
            # straight onto the row: db.commit() would persist it before
            # FastAPI ever validated the response, so the 500 this endpoint
            # raised left the report permanently unreadable (every later GET
            # 500s the same way, since ReportOut requires a dict here).
            # Reject it up front instead.
            raise HTTPException(
                422, "extracted_fields cannot be null — omit the field to leave it unchanged, or send {} to no-op."
            )
        report.extracted_fields = {**(report.extracted_fields or {}), **incoming}
    for key, value in data.items():
        setattr(report, key, value)

    if report.status in (models.ReportStatus.extracted, models.ReportStatus.in_review):
        report.status = models.ReportStatus.in_review

    db.commit()
    db.refresh(report)
    return report


@router.post("/reports/{report_id}/finalize", response_model=schemas.ReportOut)
def finalize_report(report_id: uuid.UUID, db: Session = Depends(get_db)):
    """§9: mark a report finalized. §5: a report is meant to reach this from
    extracted/in_review — finalizing a bare draft would just freeze an empty
    record, so that's rejected rather than silently allowed."""
    report = db.get(models.Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")
    if report.status not in (models.ReportStatus.extracted, models.ReportStatus.in_review):
        raise HTTPException(409, f"Cannot finalize a report in status '{report.status.value}'")
    report.status = models.ReportStatus.finalized
    report.finalized_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(report)
    return report
