"""Template resolution — §2 / §5 / §9's `GET /report-templates` behavior in
one place, so the classify flow, the manual fallback picker, and any future
caller all resolve a (instrument_type, report_type, model) triple the same way.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import ReportTemplate


def resolve_template(
    db: Session, *, instrument_type: str, report_type: str, model: str | None
) -> ReportTemplate | None:
    """A model-specific row takes precedence; a NULL-model row is the fallback
    for every model that doesn't have its own row (§2)."""
    if model:
        specific = (
            db.query(ReportTemplate)
            .filter(
                ReportTemplate.instrument_type == instrument_type,
                ReportTemplate.report_type == report_type,
                ReportTemplate.model == model,
            )
            .one_or_none()
        )
        if specific:
            return specific
    return (
        db.query(ReportTemplate)
        .filter(
            ReportTemplate.instrument_type == instrument_type,
            ReportTemplate.report_type == report_type,
            ReportTemplate.model.is_(None),
        )
        .one_or_none()
    )
