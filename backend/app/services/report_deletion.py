"""Shared pieces of permanently deleting reports (DELETE /reports/{id} and
DELETE /instruments/{id}, which removes the instrument's reports too)."""
from __future__ import annotations

import logging
import shutil
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app import models
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# A job in one of these states still has the worker reading or writing the
# report's rows, so deleting the report under it is refused.
IN_FLIGHT_JOB_STATUSES = (
    models.ExtractionJobStatus.pending,
    models.ExtractionJobStatus.classifying,
    models.ExtractionJobStatus.extracting,
)


def count_in_flight_jobs(db: Session, attachment_ids: list[uuid.UUID]) -> int:
    """How many pending/classifying/extracting jobs these attachments have."""
    if not attachment_ids:
        return 0
    return (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.attachment_id.in_(attachment_ids),
            models.ExtractionJob.status.in_(IN_FLIGHT_JOB_STATUSES),
        )
        .count()
    )


def remove_report_files(report_id: uuid.UUID, file_paths: list[str]) -> None:
    """Best-effort removal of a deleted report's scans from local disk (§8).
    Runs after the database commit: the rows are already gone, so a file that
    can't be removed is logged and left behind rather than failing the
    request. Only touches paths inside the attachment storage root."""
    root = settings.attachment_storage_path.resolve()
    for raw in file_paths:
        path = Path(raw).resolve()
        if root in path.parents:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("Could not remove %s for deleted report %s", path, report_id)
    report_dir = (root / str(report_id)).resolve()
    if report_dir.parent == root and report_dir.is_dir():
        shutil.rmtree(report_dir, ignore_errors=True)
