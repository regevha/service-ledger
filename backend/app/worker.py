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
        db.rollback()
        logger.exception("Unhandled error processing extraction job %s (kind=%s)", job.id, job.kind)
        job = db.get(models.ExtractionJob, job.id)
        if job is not None:
            job.status = models.ExtractionJobStatus.failed
            job.error_message = "Worker crashed processing this job — see server logs."
            job.completed_at = datetime.now(timezone.utc)
            db.commit()
    return True


def run_forever() -> None:
    """The actual `python -m app.worker` entry point: one dedicated process,
    one dedicated session per iteration, polling forever (§3). A fresh
    session per job (rather than one long-lived session for the process'
    whole life) keeps a stuck or errored job from poisoning every job after
    it with a half-open transaction."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s worker %(levelname)s %(message)s")
    logger.info(
        "Calibration Ledger worker starting (poll interval %.1fs, live_claude=%s)",
        settings.worker_poll_interval_seconds,
        settings.use_live_claude,
    )
    while True:
        with SessionLocal() as db:
            processed = process_one_job(db)
        if not processed:
            time.sleep(settings.worker_poll_interval_seconds)


if __name__ == "__main__":
    run_forever()
