"""The extraction-job queue helpers the background worker uses: claim the next
pending job, notice a cancelled one, fail a job, and recover jobs a dead worker
left half done. Split out of app/worker.py (no code changed); worker.py imports
these under the same names."""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import models


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


def _recover_orphaned_jobs(db: Session) -> int:
    """Run once at worker startup (§3's crash-recovery gap): within a single
    run_forever process, process_one_job always drives a claimed job to
    succeeded/failed before returning, so `classifying`/`extracting` are
    otherwise a dead end — the only way a job is left sitting in one of
    those statuses is that a previous worker process died (crashed, was
    killed, the host restarted) after claiming it but before finishing it.
    `_claim_next_job` only ever looks at `status == pending`, so such a job
    would otherwise sit there silently forever, invisible to the queue and
    to the frontend's poll (which is watching the job it already knows
    about, not scanning for new ones). Marks them failed with a clear
    message rather than silently resubmitting them — classify/extract cost
    a real API call, so a crash-looping job should stop and wait for a
    deliberate retry (the review screen's "Try again"), not retry itself
    silently on every restart."""
    orphaned = (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.status.in_(
                [
                    models.ExtractionJobStatus.classifying,
                    models.ExtractionJobStatus.extracting,
                    models.ExtractionJobStatus.translating,
                ]
            )
        )
        .all()
    )
    for job in orphaned:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Worker restarted while this job was in progress — resubmit to retry."
        job.completed_at = datetime.now(timezone.utc)
    if orphaned:
        db.commit()
    return len(orphaned)
