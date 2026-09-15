from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.models import ReportType
from app.services.templates import resolve_template

router = APIRouter(tags=["report-templates"])


@router.get("/report-templates", response_model=list[schemas.ReportTemplateOut])
def list_report_templates(
    instrument_type: str = "facs",
    model: str | None = Query(None, description="Resolve to this model's variant when one exists"),
    report_type: ReportType | None = Query(None, description="Limit to one report type"),
    db: Session = Depends(get_db),
):
    """§9: also what the manual fallback picker in §4 calls when
    classification is uncertain — the same resolution logic either way, so
    the picker can never suggest a template classify() itself couldn't reach."""
    report_types = [report_type] if report_type else list(ReportType)
    resolved = []
    for rt in report_types:
        template = resolve_template(db, instrument_type=instrument_type, report_type=rt.value, model=model)
        if template:
            resolved.append(template)
    return resolved
