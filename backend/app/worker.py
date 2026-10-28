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
from app.debug_claude_log import announce_debug_log
from app.services.classification import classify as run_classify
from app.services.duplicates import normalize_work_order
from app.services.errors import ClassificationError, ExtractionError, TranslationError
from app.services import prompt_gate
from app.services.extraction import extract as run_extract
from app.services.serial_check import correct_serial_typos
from app.services.text_reader import extract_text
from app.services.translation import identifier_check, translate as run_translate
from app.trace import bound_job, configure_logging

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

    job.status = {
        models.ExtractionJobKind.classify: models.ExtractionJobStatus.classifying,
        models.ExtractionJobKind.extract: models.ExtractionJobStatus.extracting,
        models.ExtractionJobKind.translate: models.ExtractionJobStatus.translating,
    }[job.kind]
    db.commit()
    db.refresh(job)
    return job


def _fail_job(db: Session, job: models.ExtractionJob, message: str) -> None:
    job.status = models.ExtractionJobStatus.failed
    job.error_message = message
    job.completed_at = datetime.now(timezone.utc)
    db.commit()


def _run_classify_job(db: Session, job: models.ExtractionJob) -> None:
    attachment = db.get(models.Attachment, job.attachment_id)
    if attachment is None:
        # The attachment/report was deleted out from under a queued job
        # (DELETE /reports/{id} and /instruments/{id} refuse while a job is in
        # flight, but a delete can still land between claim and here) —
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

    # Re-read the report under a row lock *after* the (slow) classify call,
    # not before it: a report finalized while Claude was working must still
    # be caught here, and the lock holds off a concurrent finalize/confirm
    # until this job's own commit below, so the check can't go stale between
    # here and the write.
    report = attachment.report
    db.refresh(report, with_for_update=True)
    if report.status == models.ReportStatus.finalized:
        # The router rejects this synchronously before enqueuing (see
        # app/routers/attachments.py's classify_attachment), but a report can
        # still be finalized between submit and here. Reject rather than
        # silently overwriting instrument_id/template_id and reverting
        # status on an already-finalized report.
        _fail_job(db, job, "Report was finalized after this job was submitted — classification discarded.")
        return
    if result.resolved_instrument_id and result.resolved_template_id:
        # Confident on both — resolve automatically and move straight toward
        # extraction (§4: "the system resolves the matching template
        # automatically and moves straight to extraction"). The frontend
        # still submits the separate POST /attachments/{id}/extract call
        # once it sees this on the job — the worker doesn't chain straight
        # into extraction itself, since a technician may still want to look
        # at a confident classification before committing to it.
        if report.template_id != result.resolved_template_id:
            # Same rule confirm_template (routers/reports.py) applies: values
            # extracted under a different template aren't corrections to
            # keep, they're noise to discard. Without this, re-classifying an
            # already-extracted report onto a new template left the old
            # template's field keys sitting in extracted_fields.
            report.extracted_fields = {}
        report.instrument_id = result.resolved_instrument_id
        report.template_id = result.resolved_template_id
        report.status = models.ReportStatus.classified
    # Below threshold on either guess: leave instrument/template NULL. The
    # technician (or a caller) must PATCH /reports/{id}/template with a
    # manual pick before extraction can run (§4's fallback path) — nothing
    # else for this job to do.

    # Remember the work order read off the document so a later upload of the
    # same visit (a different file, same work order) is flagged as a duplicate.
    attachment.work_order_number = normalize_work_order(result.work_order_number)
    # Who issued the form and a second report type, when the model read them.
    # Only overwritten with a value actually read, so a re-classify never blanks
    # what a person already has.
    if result.issuer:
        report.issuer = result.issuer
    if result.report_type_note:
        report.report_type_note = result.report_type_note

    job.status = models.ExtractionJobStatus.succeeded
    job.completed_at = datetime.now(timezone.utc)
    db.commit()


def _run_translate_job(db: Session, job: models.ExtractionJob) -> None:
    """Translate one attachment and store the result for review. A document that
    is not Hebrew gets a `not_needed` record and nothing to review. A new
    translation replaces any earlier one, which is kept as history (superseded)."""
    attachment = db.get(models.Attachment, job.attachment_id)
    if attachment is None:
        _fail_job(db, job, "Attachment no longer exists.")
        return
    if attachment.report.status == models.ReportStatus.finalized:
        _fail_job(db, job, "Report was finalized after this job was submitted — translation discarded.")
        return

    include_pages = list((job.params or {}).get("include_pages") or [])
    try:
        result = run_translate(attachment, include_pages)
    except TranslationError as e:
        _fail_job(db, job, str(e))
        return

    # Re-read under a row lock after the slow call, like the other job kinds.
    report = attachment.report
    db.refresh(report, with_for_update=True)
    if report.status == models.ReportStatus.finalized:
        _fail_job(db, job, "Report was finalized while this translation was running — translation discarded.")
        return

    for earlier in attachment.translations:
        if earlier.status != models.TranslationStatus.superseded:
            earlier.status = models.TranslationStatus.superseded

    if result is None:
        row = models.Translation(
            attachment_id=attachment.id,
            status=models.TranslationStatus.not_needed,
            source_language="other",
            ignored_pages=[],
            included_pages=[],
            identifier_check={},
            notes=[],
            reader="model" if settings.use_live_claude else "stub",
        )
    else:
        original_text = ""
        try:
            with open(attachment.file_path, "rb") as f:
                original_text = extract_text(f.read())
        except OSError:
            pass
        row = models.Translation(
            attachment_id=attachment.id,
            status=models.TranslationStatus.pending_review,
            source_language=result.source_language,
            hebrew_share=result.hebrew_share,
            model_text=result.translated_text,
            ignored_pages=result.ignored_pages,
            included_pages=include_pages,
            identifier_check=identifier_check(result.identifiers, result.translated_text, original_text),
            notes=result.notes,
            reader=result.reader,
            model=settings.anthropic_model if result.reader == "model" else None,
        )
    db.add(row)
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
    if report.status == models.ReportStatus.finalized:
        # Cheap early-out so a report finalized between submit and pickup
        # doesn't spend an API call — the router (extract_attachment) already
        # rejects this synchronously. Not sufficient on its own: the
        # authoritative re-check happens under a row lock after run_extract.
        job.status = models.ExtractionJobStatus.failed
        job.error_message = "Report was finalized after this job was submitted — extraction discarded."
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        return

    template = db.get(models.ReportTemplate, report.template_id)

    try:
        result = run_extract(attachment, template)
    except ExtractionError as e:
        _fail_job(db, job, str(e))
        return

    # The checks above ran *before* the slow extract call — a report can be
    # finalized, or moved to a different template (PATCH .../template), while
    # Claude is still working. Re-read it under a row lock and re-check before
    # writing anything: the lock holds off a concurrent finalize/confirm until
    # this job's commit, so nothing can change between this check and the
    # write below.
    db.refresh(report, with_for_update=True)
    if report.status == models.ReportStatus.finalized:
        _fail_job(db, job, "Report was finalized while this extraction was running — extraction discarded.")
        return
    if report.template_id != template.id:
        _fail_job(
            db, job, "Report's template changed while this extraction was running — extraction discarded; resubmit."
        )
        return

    instrument = db.get(models.Instrument, report.instrument_id)
    if instrument is not None:
        for fix in correct_serial_typos(result.extracted_fields, instrument.serial_number):
            logger.warning(
                "Extraction job %s: replaced %r in field %r with the instrument's serial", job.id, fix.found, fix.field
            )
    report.extracted_fields = result.extracted_fields
    # New values: whatever was marked as checked belonged to the old ones.
    report.checked_fields = []
    if result.report_date is not None:
        # Only overwrite with a date actually read off the document — when
        # none could be read, keep whatever the report already has (e.g. a
        # date the technician entered by hand) rather than blanking it.
        report.report_date = result.report_date
    report.status = models.ReportStatus.extracted
    job.field_confidences = result.field_confidences
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

    job_id, kind = job.id, job.kind
    attachment = db.get(models.Attachment, job.attachment_id)
    with bound_job(job_id, attachment.report_id if attachment else None, job.attachment_id):
        _run_claimed_job(db, job, job_id, kind)
    return True


def _run_claimed_job(db: Session, job: models.ExtractionJob, job_id, kind) -> None:
    """One claimed job, with its lifecycle in the log: started, then finished with
    the outcome and the time it took. The ids are bound by the caller, so every
    line here and below (the Claude call, a warning) carries them."""
    started_at = time.perf_counter()
    queued_for = (datetime.now(timezone.utc) - job.started_at).total_seconds() if job.started_at else 0.0
    logger.info("Job %s started (kind=%s, queued %.1fs)", job_id, kind.value, queued_for)
    approved_token = prompt_gate.approved_var.set(bool((job.params or {}).get("prompt_approved")))
    try:
        if job.kind == models.ExtractionJobKind.classify:
            _run_classify_job(db, job)
        elif job.kind == models.ExtractionJobKind.translate:
            _run_translate_job(db, job)
        else:
            _run_extract_job(db, job)
    except prompt_gate.PromptApprovalNeeded as pause:
        # VIEW_PROMPTS: park the job with the prompt for a person to read.
        db.rollback()
        parked = db.get(models.ExtractionJob, job_id)
        if parked is not None:
            parked.status = models.ExtractionJobStatus.awaiting_approval
            parked.prompt_preview = pause.preview
            db.commit()
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
    prompt_gate.approved_var.reset(approved_token)
    outcome = "unknown"
    try:
        db.expire_all()
        finished = db.get(models.ExtractionJob, job_id)
        outcome = finished.status.value if finished is not None else "missing"
    except Exception:  # noqa: BLE001 - the summary line must not take the worker down
        pass
    logger.info("Job %s finished: %s in %.1fs", job_id, outcome, time.perf_counter() - started_at)


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
    configure_logging("worker")
    announce_debug_log()
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
