from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.models import DEFAULT_INSTRUMENT_TYPE_KEY, ReportType
from app.services.attachment_names import source_name
from app.services import template_records as svc

router = APIRouter(tags=["report-templates"])


@router.get("/report-templates", response_model=list[schemas.ReportTemplateOut])
def list_report_templates(
    instrument_type: str = DEFAULT_INSTRUMENT_TYPE_KEY,
    model: str | None = Query(None, description="Resolve to this model's variant when one exists"),
    report_type: ReportType | None = Query(None, description="Limit to one report type"),
    db: Session = Depends(get_db),
):
    return svc.resolved_templates(db, instrument_type, model, report_type)


@router.get("/report-templates/all", response_model=list[schemas.ReportTemplateOut])
def list_all_report_templates(db: Session = Depends(get_db)):
    """The template-management screen's list view: every row, unresolved —
    unlike GET /report-templates above, this doesn't pick one row per
    report_type via resolve_template()'s model-fallback logic, since an
    admin editing templates needs to see (and edit) every variant, including
    ones a given model would never actually resolve to. Registered before
    /report-templates/{template_id} below so "all" is never swallowed as a
    template_id path param."""
    return svc.all_templates(db)


@router.get("/report-templates/usage", response_model=list[schemas.TemplateUsageOut])
def report_template_usage(db: Session = Depends(get_db)):
    """Per template, how many reports use it and how many of those are
    finalized. One query for the whole list, so the management screen does not
    ask once per row. Registered before /report-templates/{template_id} so
    "usage" is never read as a template id."""
    return svc.template_usage(db)


@router.get("/report-templates/suggestions", response_model=list[schemas.TemplateSuggestionOut])
def report_template_suggestions(
    report_type: ReportType = Query(..., description="Only templates of this report type are offered"),
    instrument_type: str = DEFAULT_INSTRUMENT_TYPE_KEY,
    model: str | None = Query(None, description="The model the new template is for"),
    limit: int = Query(3, ge=1, le=10),
    db: Session = Depends(get_db),
):
    """The closest existing templates to start a new one from, best first, each
    with the reason it was picked. Read-only: it never creates or changes a
    template. Registered before /report-templates/{template_id} so
    "suggestions" is never read as a template id."""
    return svc.suggestions(db, report_type, instrument_type, model, limit)


@router.get("/report-templates/compare", response_model=schemas.TemplateCompareOut)
def compare_report_templates(left: uuid.UUID, right: uuid.UUID, db: Session = Depends(get_db)):
    """Two templates of the same instrument type with their fields lined up:
    shared, differing (type, unit, notes, options, table columns, spelling of
    the name), only on one side, and possible matches (differently named fields
    an alias group lists as the same concept). Read-only: it never changes a template, and
    what to do about a difference stays a person's decision. Registered before
    /report-templates/{template_id} so "compare" is never read as a template id."""
    return svc.compare(db, left, right)


@router.get("/report-templates/sample-scans", response_model=list[schemas.SampleScanOut])
def list_sample_scans(
    report_type: ReportType | None = Query(None, description="Offer scans of this report type first"),
    model: str | None = Query(None, description="Offer scans of this instrument model first"),
    limit: int = Query(12, ge=1, le=30),
    db: Session = Depends(get_db),
):
    """Stored PDFs the template editor can show while a person picks fields from
    one: the newest first, with scans of the same report type and model ahead of
    the rest. Images are left out (nothing to pick text from), and so are files
    whose report has been deleted. Registered before /report-templates/{template_id}
    so "sample-scans" is never read as a template id."""
    attachments = (
        db.query(models.Attachment)
        .filter(models.Attachment.file_type == "application/pdf")
        .order_by(models.Attachment.created_at.desc())
        .limit(300)
        .all()
    )
    wanted_model = (model or "").strip().casefold()
    ranked: list[tuple[int, int, schemas.SampleScanOut]] = []
    for position, attachment in enumerate(attachments):
        report = attachment.report
        this_type = report.template.report_type if report.template else None
        this_model = report.instrument.model if report.instrument else None
        same_type = report_type is not None and this_type == report_type
        same_model = bool(wanted_model) and (this_model or "").strip().casefold() == wanted_model
        if same_type and same_model:
            rank, reason = 0, "Same report type and model"
        elif same_type:
            rank, reason = 1, "Same report type"
        elif same_model:
            rank, reason = 2, "Same model"
        else:
            rank, reason = 3, "Another report"
        ranked.append(
            (
                rank,
                position,
                schemas.SampleScanOut(
                    attachment_id=attachment.id,
                    report_id=report.id,
                    file_name=source_name(attachment),
                    report_type=this_type,
                    instrument_model=this_model,
                    instrument_serial_number=report.instrument.serial_number if report.instrument else None,
                    report_date=report.report_date,
                    reason=reason,
                ),
            )
        )
    ranked.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in ranked[:limit]]


@router.get("/report-templates/{template_id}", response_model=schemas.ReportTemplateOut)
def get_report_template(template_id: uuid.UUID, db: Session = Depends(get_db)):
    return svc.get_template(db, template_id)


@router.post("/report-templates", response_model=schemas.ReportTemplateOut, status_code=201)
def create_report_template(payload: schemas.TemplateCreate, db: Session = Depends(get_db)):
    return svc.create_template(db, payload)


@router.patch("/report-templates/{template_id}", response_model=schemas.ReportTemplateOut)
def update_report_template(template_id: uuid.UUID, payload: schemas.TemplateUpdate, db: Session = Depends(get_db)):
    return svc.update_template(db, template_id, payload)


@router.delete("/report-templates/{template_id}", status_code=204)
def delete_report_template(template_id: uuid.UUID, db: Session = Depends(get_db)):
    svc.delete_template(db, template_id)
