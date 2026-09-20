"""The background worker — §3's "single background worker process, polling a
job table in Postgres."

Before this module existed, `app/routers/attachments.py` ran
`classify()`/`extract()` inline inside the HTTP request handling
`POST /attachments/{id}/classify` and `.../extract` — functionally correct
for a demo, but exactly the thing §3 says not to do ("long enough that it
shouldn't block an HTTP request"). Those two endpoints now do nothing but
insert a `pending` `ExtractionJob` row and return immediately (§9's
submit-and-poll contract); this module is the process that actually drains
that queue, so it has to be running for a report to ever leave `classified`
or `extracted`.

One `ExtractionJob` row is one `kind` (`classify` or `extract`, see
`models.ExtractionJobKind`) rather than the spec's prose description of "one
classify-then-extract attempt" spanning both — a real human-confirm
checkpoint can sit between the two (§4/§6: an uncertain classification
pauses for a manual pick before extraction is ever submitted), so a single
job row can't own both stages start to finish. `process_one_job` is the unit
the pytest suite calls directly (no real polling loop, no sleep) to drive a
job to completion deterministically inside a test; `run_forever` is what
actually runs continuously behind `python -m app.worker` in dev/demo.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.db import SessionLocal
from app.services.classification import classify as run_classify
from app.services.errors import ClassificationError, ExtractionError
from app.services.extraction import extract as run_extract

logger = logging.getLogger("app.worker")
settings = get_settings()


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

    job.status = (
        models.ExtractionJobStatus.classifying
        if job.kind == models.ExtractionJobKind.classify
        else models.ExtractionJobStatus.extracting
    )
    db.commit()
    db.refresh(job)
    return job


def _run_classify_job(db: Session, job: models.ExtractionJob) -> None:
    attachment = db.get(models.Attachment, job.attachment_id)
    if attachment is None:
        # The attachment/report was deleted out from under a queued job —
        # not a real code path today (no delete endpoint exists, §10), but
        # cheaper to guard than to let the worker crash on a None.
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Attachment no longer exists."
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    try:
        result = run_classify(db, attachment)
    except ClassificationError as e:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = str(e)
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    job.classification = result.model_dump(mode="json")

    report = attachment.report
    if result.resolved_instrument_id and result.resolved_template_id:
        # Confident on both — resolve automatically and move straight toward
        # extraction (§4: "the system resolves the matching template
        # automatically and moves straight to extraction"). The frontend
        # still submits the separate POST /attachments/{id}/extract call
        # once it sees this on the job — the worker doesn't chain straight
        # into extraction itself, since a technician may still want to look
        # at a confident classification before committing to it.
        report.instrument_id = result.resolved_instrument_id
        report.template_id = result.resolved_template_id
        report.status = models.ReportStatus.classified
    # Below threshold on either guess: leave instrument/template NULL. The
    # technician (or a caller) must PATCH /reports/{id}/template with a
    # manual pick before extraction can run (§4's fallback path) — nothing
    # else for this job to do.

    job.status = models.ExtractionJobStatus.succeeded
    job.completed_at = datetime.now(timezone.utc)
    db.commit()


def _run_extract_job(db: Session, job: models.ExtractionJob) -> None:
    attachment = db.get(models.Attachment, job.attachment_id)
    if attachment is None:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Attachment no longer exists."
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    report = attachment.report
    if not report.template_id or not report.instrument_id:
        # Submitting this shouldn't be possible — the router checks the same
        # condition synchronously before ever enqueuing the job (§9) — but a
        # template could in principle be un-resolved between submit and
        # pickup (e.g. two attachments on the same report racing), so the
        # worker re-checks rather than trusting the state it was enqueued
        # under.
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Report has no resolved instrument/template — classify and confirm a template first (§4)."
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    template = db.get(models.ReportTemplate, report.template_id)

    try:
        extracted_fields, field_confidences = run_extract(attachment, template)
    except ExtractionError as e:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = str(e)
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    report.extracted_fields = extracted_fields
    report.status = models.ReportStatus.extracted
    job.field_confidences = field_confidences
    job.status = models.ExtractionJobStatus.succeeded
    job.completed_at = datetime.now(timezone.utc)
    db.commit()


def process_one_job(db: Session) -> bool:
    """Claim and fully run the single oldest pending job, if there is one.
    Returns whether a job was found — the pytest suite loops on this
    (`while process_one_job(db): ...`) to drain the queue synchronously
    instead of racing a real sleep-based loop against test assertions."""
    job = _claim_next_job(db)
    if job is None:
        return False

    try:
        if job.kind == models.ExtractionJobKind.classify:
            _run_classify_job(db, job)
        else:
            _run_extract_job(db, job)
    except Exception:  # noqa: BLE001 — a bug in this file must not wedge the queue
        logger.exception("Unhandled error processing extraction job %s (kind=%s)", job.id, job.kind)
        try:
            db.rollback()
            failed_job = db.get(models.ExtractionJob, job.id)
            if failed_job is not None:
                failed_job.status = models.ExtractionJobStatus.failed
                failed_job.error_message = "Worker crashed processing this job — see server logs."
                failed_job.completed_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:  # noqa: BLE001
            # The exception above wasn't just a bug in this file's own logic
            # — the session/connection itself is what's broken (a dropped
            # DB connection, a deadlock), so rollback()/get()/commit() can
            # raise too. That second failure must not escape and take the
            # whole worker process down with it (this used to be exactly
            # that: uncaught, it propagated out of process_one_job into
            # run_forever's bare loop and killed the process, silently
            # stranding every job submitted afterward in `pending` forever).
            # The job is left stuck in classifying/extracting; the next
            # worker startup's _recover_orphaned_jobs cleans it up.
            logger.exception(
                "Also failed to mark extraction job %s as failed after the error above — it will stay "
                "in-progress until the worker restarts and _recover_orphaned_jobs picks it up.",
                job.id,
            )
    return True


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
                [models.ExtractionJobStatus.classifying, models.ExtractionJobStatus.extracting]
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


def _worker_tick() -> bool:
    """One iteration of run_forever's loop, factored out so its crash
    resilience — the actual point of this function — can be unit-tested
    directly rather than only by way of the infinite loop, which (like
    reset_db.py's CLI entrypoint) isn't itself covered by tests. Catches
    everything, including SessionLocal() itself failing (e.g. the DB is
    down), so one bad tick can never take the whole worker process with it
    — this used to have no top-level handling at all, so any exception that
    reached here (not just a bug in one job's processing, which
    process_one_job already guards) killed run_forever's `while True` loop
    outright."""
    try:
        with SessionLocal() as db:
            return process_one_job(db)
    except Exception:  # noqa: BLE001
        logger.exception("Unhandled error in the worker's main loop — staying up and retrying rather than exiting.")
        return False


def run_forever() -> None:
    """The actual `python -m app.worker` entry point: one dedicated process,
    one dedicated session per iteration, polling forever (§3). A fresh
    session per job (rather than one long-lived session for the process'
    whole life) keeps a stuck or errored job from poisoning every job after
    it with a half-open transaction."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s worker %(levelname)s %(message)s")
    logger.info(
        "ServiceLedger worker starting (poll interval %.1fs, live_claude=%s)",
        settings.worker_poll_interval_seconds,
        settings.use_live_claude,
    )
    with SessionLocal() as db:
        recovered = _recover_orphaned_jobs(db)
    if recovered:
        logger.warning("Recovered %d job(s) left in-progress by a previous worker run.", recovered)

    while True:
        if not _worker_tick():
            time.sleep(settings.worker_poll_interval_seconds)


if __name__ == "__main__":
    run_forever()
