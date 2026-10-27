"""When an instrument's preventive maintenance is due.

The rule (models plan, step 4, part A): the last maintenance is the newest
finalized preventive-maintenance report on the instrument, dated by its
report_date, or the day it was created when it has none. The instrument is
overdue when today is after that date plus its model's service interval, in
calendar months. Nothing is stored; the state is worked out on every read.
"""

from __future__ import annotations

import calendar
import uuid
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app import models

DUE_SOON_DAYS = 30

NOT_TRACKED = "not_tracked"  # the model has no service interval
NO_RECORD = "no_record"  # an interval, but no maintenance report yet
OK = "ok"
DUE_SOON = "due_soon"
OVERDUE = "overdue"


def add_months(day: date, months: int) -> date:
    """Calendar months; a day that does not exist in the target month
    (31 January + 1 month) becomes that month's last day."""
    index = day.month - 1 + months
    year, month = day.year + index // 12, index % 12 + 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def state_for(interval: int | None, last: date | None, today: date) -> tuple[date | None, str | None]:
    """(due date, state). State is None for a retired instrument is the
    caller's business; this only applies the interval rule."""
    if interval is None:
        return None, NOT_TRACKED
    if last is None:
        return None, NO_RECORD
    due = add_months(last, interval)
    if today > due:
        return due, OVERDUE
    if today >= due - timedelta(days=DUE_SOON_DAYS):
        return due, DUE_SOON
    return due, OK


def last_maintenance_dates(db: Session, ids: list[uuid.UUID]) -> dict[uuid.UUID, date]:
    """Newest finalized preventive-maintenance day per instrument, one query."""
    if not ids:
        return {}
    day = func.coalesce(models.Report.report_date, func.date(models.Report.created_at))
    rows = (
        db.query(models.Report.instrument_id, func.max(day))
        .join(models.ReportTemplate, models.Report.template_id == models.ReportTemplate.id)
        .filter(
            models.Report.instrument_id.in_(ids),
            models.Report.status == models.ReportStatus.finalized,
            models.ReportTemplate.report_type == models.ReportType.preventive_maintenance,
        )
        .group_by(models.Report.instrument_id)
        .all()
    )
    return {instrument_id: last for instrument_id, last in rows}


def annotate(db: Session, instruments: list[models.Instrument], today: date | None = None) -> None:
    """Set last_maintenance_date, maintenance_due_date and maintenance_state
    on each instrument object (plain attributes, read by InstrumentOut).
    Retired instruments get no state."""
    today = today or date.today()
    last_by_id = last_maintenance_dates(db, [i.id for i in instruments])
    for instrument in instruments:
        last = last_by_id.get(instrument.id)
        interval = instrument.model_record.service_interval_months if instrument.model_record else None
        due, state = state_for(interval, last, today)
        instrument.last_maintenance_date = last
        instrument.maintenance_due_date = due
        instrument.maintenance_state = None if instrument.status == models.InstrumentStatus.retired else state
