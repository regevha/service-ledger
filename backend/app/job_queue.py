"""The extraction-job queue helpers the background worker uses: claim the next
pending job, notice a cancelled one, fail a job, and recover jobs a dead worker
left half done. Split out of app/worker.py (no code changed); worker.py imports
these under the same names."""
import logging
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.db import SessionLocal

logger = logging.getLogger("app.worker")


def _claim_next_job(db: Session) -> models.ExtractionJob | None:
    """Grab the oldest pending job and mark it as being worked, in one
    transaction. `with_for_update(skip_locked=True)` is a no-op at today's
    single-worker scale (nothing else is ever racing for this row) but is
    exactly the line §3/§8 says lets this "upgrade to Redis/Celery later
    without changing the API contract" — multiple worker processes could run
    this same query safely without ever double-claiming a row."""
    job = (
        db.query(models.ExtractionJob)
        .filter(models.ExtractionJob.status == models.ExtractionJobStatus.pending)
        .order_by(models.ExtractionJob.started_at)
        .with_for_update(skip_locked=True)
        .first()
    )
    if job is None:
        return None

    job.status = {
        models.ExtractionJobKind.classify: models.ExtractionJobStatus.classifying,
        models.ExtractionJobKind.extract: models.ExtractionJobStatus.extracting,
        models.ExtractionJobKind.translate: models.ExtractionJobStatus.translating,
    }[job.kind]
    job.heartbeat_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(job)
    return job


def _was_cancelled(db: Session, job_id) -> bool:
    """True when the person cancelled this job (or deleted its report) while the worker was busy
    with the slow call. The caller then writes nothing: the result is thrown away."""
    db.rollback()  # end the transaction so this reads what was committed meanwhile
    row = db.execute(select(models.ExtractionJob.params).where(models.ExtractionJob.id == job_id)).first()
    return row is None or bool((row[0] or {}).get("cancelled"))


def _fail_job(db: Session, job: models.ExtractionJob, message: str) -> None:
    job.status = models.ExtractionJobStatus.failed
    job.error_message = message
    job.completed_at = datetime.now(timezone.utc)
    db.commit()


def _beat(job_id) -> None:
    """Mark one job as alive, on its own short session so a long Claude call on the
    worker's main session never blocks or is blocked by it."""
    with SessionLocal() as db:
        db.execute(
            update(models.ExtractionJob)
            .where(models.ExtractionJob.id == job_id)
            .values(heartbeat_at=datetime.now(timezone.utc))
        )
        db.commit()


@contextmanager
def _heartbeat(job_id):
    """Keep `heartbeat_at` fresh for as long as the worker is busy with this job, so
    another worker's recovery can tell a slow job from an orphaned one. A failed
    beat is logged and skipped: the job itself must not die because of it."""
    stop = threading.Event()
    interval = get_settings().worker_heartbeat_interval_seconds

    def run() -> None:
        while not stop.wait(interval):
            try:
                _beat(job_id)
            except Exception:  # noqa: BLE001
                logger.warning("Could not refresh the heartbeat of job %s", job_id, exc_info=True)

    thread = threading.Thread(target=run, name=f"heartbeat-{job_id}", daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)


def _recover_orphaned_jobs(db: Session, stale_after_seconds: float | None = None) -> int:
    """Fail jobs a dead worker left in classifying/extracting/translating (§3's
    crash-recovery gap). `_claim_next_job` only looks at `status == pending`, so
    such a job would otherwise sit there forever, invisible to the queue and to the
    frontend's poll.

    With more than one worker or replica, "in progress" no longer means "orphaned":
    another worker may be running it right now. A job counts as orphaned only when
    its heartbeat is missing (claimed before heartbeats existed, or the worker died
    before its first beat) or older than `worker_stale_after_seconds`. Safe to call
    from every worker, at startup and periodically.

    Marks them failed with a clear message rather than silently resubmitting
    them — classify/extract cost a real API call, so a crash-looping job should
    stop and wait for a deliberate retry (the review screen's "Try again")."""
    if stale_after_seconds is None:
        stale_after_seconds = get_settings().worker_stale_after_seconds
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=stale_after_seconds)
    orphaned = (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.status.in_(
                [
                    models.ExtractionJobStatus.classifying,
                    models.ExtractionJobStatus.extracting,
                    models.ExtractionJobStatus.translating,
                ]
            ),
            (models.ExtractionJob.heartbeat_at.is_(None)) | (models.ExtractionJob.heartbeat_at < cutoff),
        )
        .with_for_update(skip_locked=True)
        .all()
    )
    for job in orphaned:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Worker restarted while this job was in progress — resubmit to retry."
        job.completed_at = datetime.now(timezone.utc)
    if orphaned:
        db.commit()
    return len(orphaned)


_MIN_RETENTION_DAYS = 2  # the caps in job_limits count over 24 hours; never prune inside that window


def prune_finished_jobs(db: Session, retention_days: int | None = None) -> int:
    """Delete finished (succeeded or failed) jobs completed more than `retention_days` ago, but
    always keep the newest finished job of each kind per document: the screens and the retry
    limit read the latest one. Jobs still pending or in progress are never touched. Returns how
    many rows were deleted. 0 days switches pruning off."""
    if retention_days is None:
        retention_days = get_settings().job_retention_days
    if retention_days <= 0:
        return 0
    cutoff = datetime.now(timezone.utc) - timedelta(days=max(retention_days, _MIN_RETENTION_DAYS))
    finished = [models.ExtractionJobStatus.succeeded, models.ExtractionJobStatus.failed]
    ranked = (
        select(
            models.ExtractionJob.id.label("id"),
            models.ExtractionJob.completed_at.label("completed_at"),
            func.row_number()
            .over(
                partition_by=(models.ExtractionJob.attachment_id, models.ExtractionJob.kind),
                order_by=(models.ExtractionJob.started_at.desc().nulls_last(), models.ExtractionJob.id.desc()),
            )
            .label("rank"),
        )
        .where(models.ExtractionJob.status.in_(finished))
        .subquery()
    )
    doomed = select(ranked.c.id).where(ranked.c.rank > 1, ranked.c.completed_at < cutoff)
    result = db.execute(delete(models.ExtractionJob).where(models.ExtractionJob.id.in_(doomed)))
    db.commit()
    return result.rowcount or 0
