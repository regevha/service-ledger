"""The figures on the Home screen, computed from the reports themselves (nothing is stored for them)."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import models, schemas

ACCURACY_DAYS = 30


def _start_of(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=timezone.utc)


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _previous_month_start(day: date) -> date:
    return _month_start(_month_start(day) - timedelta(days=1))


def _blank(value: object) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "") or value == [] or value == {}


def _same(read: object, kept: object) -> bool:
    if isinstance(read, str) and isinstance(kept, str):
        return read.strip() == kept.strip()
    return read == kept


def read_accuracy(db: Session, today: date) -> schemas.HomeReadAccuracyOut:
    """A field counts when the reading filled it in. It is "unchanged" when the saved value equals what was
    first read; a field the person filled in by hand after the reading left it empty is not counted at all,
    since nothing was read to be right or wrong."""
    since = _start_of(today - timedelta(days=ACCURACY_DAYS))
    rows = db.scalars(
        select(models.Report).where(
            models.Report.status == models.ReportStatus.finalized,
            models.Report.finalized_at >= since,
            models.Report.original_fields.is_not(None),
        )
    ).all()
    reports = fields = unchanged = 0
    for report in rows:
        original = report.original_fields or {}
        kept = report.extracted_fields or {}
        counted = 0
        for key, read in original.items():
            if _blank(read):
                continue
            counted += 1
            if _same(read, kept.get(key)):
                unchanged += 1
        if counted:
            reports += 1
            fields += counted
    return schemas.HomeReadAccuracyOut(days=ACCURACY_DAYS, reports=reports, fields=fields, unchanged=unchanged)


def home_summary(db: Session, today: date) -> schemas.HomeSummaryOut:
    waiting_statuses = (models.ReportStatus.extracted, models.ReportStatus.in_review)
    count, oldest = db.execute(
        select(func.count(models.Report.id), func.min(models.Report.created_at)).where(
            models.Report.status.in_(waiting_statuses)
        )
    ).one()

    this_start = _month_start(today)
    last_start = _previous_month_start(today)

    def finalized_between(start: date, end: date | None) -> int:
        stmt = select(func.count(models.Report.id)).where(
            models.Report.status == models.ReportStatus.finalized,
            models.Report.finalized_at >= _start_of(start),
        )
        if end is not None:
            stmt = stmt.where(models.Report.finalized_at < _start_of(end))
        return db.scalar(stmt) or 0

    return schemas.HomeSummaryOut(
        waiting=schemas.HomeWaitingOut(count=count or 0, oldest_created_at=oldest),
        finalized=schemas.HomeFinalizedOut(
            this_month=finalized_between(this_start, None), last_month=finalized_between(last_start, this_start)
        ),
        read_without_edits=read_accuracy(db, today),
    )
