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
counted. Raises HTTP 429 with a message a person can act on.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings

WINDOW = timedelta(hours=24)
CANCELLED_UNSENT = "Cancelled before the prompt was sent to Claude."


def _counted(query):
    """Jobs that cost (or may have cost) a model call: not the ones cancelled unsent."""
    return query.filter(
        or_(models.ExtractionJob.error_message.is_(None), models.ExtractionJob.error_message != CANCELLED_UNSENT)
    )


def enforce_job_limits(db: Session, attachment_id: uuid.UUID, kind: models.ExtractionJobKind) -> None:
    settings = get_settings()
    since = datetime.now(timezone.utc) - WINDOW

    if settings.daily_job_cap > 0:
        today = _counted(
            db.query(func.count(models.ExtractionJob.id)).filter(models.ExtractionJob.started_at >= since)
        ).scalar()
        if today >= settings.daily_job_cap:
            raise HTTPException(
                429,
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
            raise HTTPException(
                429,
                f"This document has failed {failed} times in the last 24 hours. "
                "Check the file (is it readable? is it the right type?) before trying again later.",
            )
