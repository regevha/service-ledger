"""Spending limits on model-backed jobs (classify, extract, translate).

Two limits, both counted from the `extraction_jobs` table so they hold across
restarts and, later, across several API replicas:

* a daily cap on all new jobs (`DAILY_JOB_CAP`, default 60), so one runaway
  client or a stuck retry loop cannot spend without bound;
* a retry limit per document and kind (`MAX_FAILED_ATTEMPTS_PER_ATTACHMENT`,
  default 3 failed attempts in the window), so a document the model cannot read
  is not paid for again and again.

"Daily" is a rolling 24 hours, which avoids a time-zone argument about where
midnight is. A job cancelled before its prompt was sent cost nothing and is not
counted, nor is a job that finished without calling the model (the language check of a
document with a readable text layer, which is one of the three jobs a batch queues per file).
Raises HTTP 429 with a message a person can act on.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings

WINDOW = timedelta(hours=24)
CANCELLED_UNSENT = "Cancelled before the prompt was sent to Claude."


def _counted(query):
    """Jobs that cost (or may have cost) a model call: not the ones cancelled unsent, and not the
    ones the worker marked `model_called: false` (a translate job that only read the text layer)."""
    return query.filter(
        or_(models.ExtractionJob.error_message.is_(None), models.ExtractionJob.error_message != CANCELLED_UNSENT),
        func.coalesce(models.ExtractionJob.params["model_called"].astext, "true") != "false",
    )


_UNFINISHED = (
    models.ExtractionJobStatus.pending,
    models.ExtractionJobStatus.classifying,
    models.ExtractionJobStatus.extracting,
    models.ExtractionJobStatus.translating,
    models.ExtractionJobStatus.awaiting_approval,
)


def _lock_submissions(db: Session) -> None:
    # Separate from the worker-run and mailbox locks. Web and email must
    # make the count-and-enqueue decision under the same lock.
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": 1502316812})


def find_unfinished_job(
    db: Session, attachment_id: uuid.UUID, kind: models.ExtractionJobKind
) -> models.ExtractionJob | None:
    _lock_submissions(db)
    return (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.attachment_id == attachment_id,
            models.ExtractionJob.kind == kind,
            models.ExtractionJob.status.in_(_UNFINISHED),
        )
        .order_by(models.ExtractionJob.started_at.desc())
        .first()
    )


def job_limit(
    db: Session, attachment_id: uuid.UUID, kind: models.ExtractionJobKind
) -> tuple[str, str] | None:
    """Check and reserve the decision until the caller commits its new job."""
    settings = get_settings()
    since = datetime.now(timezone.utc) - WINDOW

    if settings.daily_job_cap > 0:
        _lock_submissions(db)
        today = _counted(
            db.query(func.count(models.ExtractionJob.id)).filter(models.ExtractionJob.started_at >= since)
        ).scalar()
        if today >= settings.daily_job_cap:
            return (
                "daily",
                f"The daily limit of {settings.daily_job_cap} model jobs has been reached. "
                "Try again later, or ask the administrator to raise DAILY_JOB_CAP.",
            )

    if settings.max_failed_attempts_per_attachment > 0:
        failed = _counted(
            db.query(func.count(models.ExtractionJob.id)).filter(
                models.ExtractionJob.attachment_id == attachment_id,
                models.ExtractionJob.kind == kind,
                models.ExtractionJob.status == models.ExtractionJobStatus.failed,
                models.ExtractionJob.started_at >= since,
            )
        ).scalar()
        if failed >= settings.max_failed_attempts_per_attachment:
            return (
                "attempts",
                f"This document has failed {failed} times in the last 24 hours. "
                "Check the file (is it readable? is it the right type?) before trying again later.",
            )
    return None


def enforce_job_limits(db: Session, attachment_id: uuid.UUID, kind: models.ExtractionJobKind) -> None:
    if limit := job_limit(db, attachment_id, kind):
        raise HTTPException(429, limit[1])
