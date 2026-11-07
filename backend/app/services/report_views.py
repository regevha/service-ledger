"""How a report is shown in a list (shared by the reports and instrument-models routers)."""
from __future__ import annotations

from app import models, schemas


def list_item(r: models.Report) -> schemas.ReportListItemOut:
    """The denormalized list row for one report (see ReportListItemOut)."""
    return schemas.ReportListItemOut(
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

