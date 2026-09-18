"""Direct unit coverage of app/worker.py (§3) — the pieces the end-to-end
flow tests (test_document_first_flow.py, via the run_worker fixture) only
exercise on the happy path. This file drives `process_one_job` directly
against a plain db_session (no HTTP layer) to cover: the empty-queue
no-op, FIFO ordering across multiple pending jobs, and the "attachment
deleted out from under a queued job" defensive branch neither the router
nor a real user flow can trigger today (§10: there's no delete endpoint),
but that a worker crash there shouldn't ever produce silently.

Also covers the worker's crash-recovery path, found missing during a
test-gap analysis: a broken session surviving process_one_job's own
recovery attempt, orphaned in-progress jobs being cleaned up on worker
startup, and _worker_tick staying up when the database is unreachable at
all — none of which the happy-path/single-bad-job tests above exercised.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import models
from app.worker import _recover_orphaned_jobs, _worker_tick, process_one_job


def _make_attachment(db, *, report=None, file_path="scan.pdf") -> models.Attachment:
    if report is None:
        report = models.Report()
        db.add(report)
        db.flush()
    attachment = models.Attachment(report_id=report.id, file_path=file_path, file_type="application/pdf", page_count=1)
    db.add(attachment)
    db.flush()
    return attachment


def test_process_one_job_returns_false_on_an_empty_queue(db_session):
    assert process_one_job(db_session) is False


def test_process_one_job_processes_oldest_pending_job_first(seeded):
    db = seeded
    attachment = _make_attachment(db)
    now = datetime.now(timezone.utc)

    newer = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=now,
    )
    older = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=now - timedelta(minutes=5),
    )
    db.add(newer)
    db.add(older)
    db.commit()

    assert process_one_job(db) is True
    db.refresh(older)
    db.refresh(newer)
    # FIFO by enqueue time (§3) — the older row is claimed first regardless
    # of insertion order, so a backlog drains oldest-first rather than
    # arbitrarily.
    assert older.status == models.ExtractionJobStatus.succeeded
    assert newer.status == models.ExtractionJobStatus.pending

    assert process_one_job(db) is True
    db.refresh(newer)
    assert newer.status == models.ExtractionJobStatus.succeeded

    assert process_one_job(db) is False


def test_classify_job_for_a_missing_attachment_fails_cleanly(seeded, monkeypatch):
    """§10: there's no delete endpoint for attachments today, and the
    foreign key on extraction_jobs.attachment_id means a job outliving its
    attachment can't actually happen through the API (or even be constructed
    directly against the real schema — it's enforced at the database level).
    But a worker that crashed on a dangling reference instead of failing the
    job cleanly would be a much worse bug to discover later than this guard
    is to keep now, so this simulates "vanished between enqueue and pickup"
    by making a real, validly-referenced job's own attachment lookup miss."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()

    real_get = db.get

    def _get_that_misses_the_attachment(model, ident, *args, **kwargs):
        if model is models.Attachment:
            return None
        return real_get(model, ident, *args, **kwargs)

    monkeypatch.setattr(db, "get", _get_that_misses_the_attachment)

    assert process_one_job(db) is True
    db.refresh(job)
    assert job.status == models.ExtractionJobStatus.failed
    assert "no longer exists" in job.error_message
    assert job.completed_at is not None


def test_extract_job_for_a_missing_attachment_fails_cleanly(seeded, monkeypatch):
    """Same defensive branch as the classify version above, on the extract
    side of `process_one_job` (`app.worker._run_extract_job`)."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.extract,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()

    real_get = db.get

    def _get_that_misses_the_attachment(model, ident, *args, **kwargs):
        if model is models.Attachment:
            return None
        return real_get(model, ident, *args, **kwargs)

    monkeypatch.setattr(db, "get", _get_that_misses_the_attachment)

    assert process_one_job(db) is True
    db.refresh(job)
    assert job.status == models.ExtractionJobStatus.failed
    assert "no longer exists" in job.error_message


def test_extract_job_fails_cleanly_when_report_has_no_resolved_template(seeded):
    """Mirrors the router's own 409 (test_error_paths.py) but at the worker
    layer: defends against a template becoming un-resolved between a job
    being submitted and the worker picking it up (see the comment in
    app.worker._run_extract_job)."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.extract,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()

    assert process_one_job(db) is True
    db.refresh(job)
    assert job.status == models.ExtractionJobStatus.failed
    assert "resolved instrument/template" in job.error_message


def test_worker_crash_fails_the_job_instead_of_wedging_the_queue(seeded, monkeypatch):
    """If a bug in classification.py/extraction.py raised something other
    than ClassificationError/ExtractionError, the old inline endpoint would
    have 500'd the request — there's no request here to 500, so the worker
    has to convert that into a failed job itself or every job behind it in
    the queue would starve forever."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    job_id = job.id

    def _boom(db, attachment):
        raise RuntimeError("unexpected bug")

    monkeypatch.setattr("app.worker.run_classify", _boom)

    assert process_one_job(db) is True
    reloaded = db.get(models.ExtractionJob, job_id)
    assert reloaded.status == models.ExtractionJobStatus.failed
    assert "Worker crashed" in reloaded.error_message


def test_process_one_job_survives_when_it_cannot_even_mark_the_job_failed(seeded, monkeypatch):
    """The gap the crash-recovery fix closes: if the exception that crashed a
    job also broke the session itself (a dropped DB connection, a deadlock —
    not just a bug in classification.py/extraction.py), the *recovery*
    attempt (rollback + re-fetch the job to mark it failed) can raise too.
    That second failure must not escape process_one_job — previously it did,
    propagating out of process_one_job into run_forever's bare loop and
    killing the whole worker process, silently stranding every job behind it
    in `pending` forever."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()

    def _boom(db, attachment):
        raise RuntimeError("unexpected bug")

    monkeypatch.setattr("app.worker.run_classify", _boom)

    real_get = db.get

    def _get_that_also_cant_reach_the_job(model, ident, *args, **kwargs):
        if model is models.ExtractionJob:
            raise RuntimeError("connection lost")
        return real_get(model, ident, *args, **kwargs)

    monkeypatch.setattr(db, "get", _get_that_also_cant_reach_the_job)

    # The whole point: this must not raise, even though both the job and its
    # own recovery attempt failed.
    assert process_one_job(db) is True

    # Recovery couldn't reach the job to mark it failed, so it's left stuck
    # in-progress — exactly the state _recover_orphaned_jobs exists to clean
    # up on the next worker restart (covered below).
    db.refresh(job)
    assert job.status == models.ExtractionJobStatus.classifying


def test_recover_orphaned_jobs_fails_jobs_stuck_in_progress(seeded):
    """classifying/extracting are otherwise a dead end within one worker
    process's lifetime — process_one_job always drives a claimed job to
    succeeded/failed before returning. The only way a job is left in one of
    those statuses is that a previous worker process died after claiming it
    but before finishing — _claim_next_job only ever looks at
    `status == pending`, so without this recovery step such a job would sit
    there silently forever, invisible to the queue and to the frontend's
    poll."""
    db = seeded
    attachment = _make_attachment(db)
    stuck_classifying = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.classifying,
        started_at=datetime.now(timezone.utc),
    )
    stuck_extracting = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.extract,
        status=models.ExtractionJobStatus.extracting,
        started_at=datetime.now(timezone.utc),
    )
    still_pending = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    already_succeeded = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.succeeded,
        started_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
    )
    db.add_all([stuck_classifying, stuck_extracting, still_pending, already_succeeded])
    db.commit()

    recovered_count = _recover_orphaned_jobs(db)
    assert recovered_count == 2

    db.refresh(stuck_classifying)
    db.refresh(stuck_extracting)
    db.refresh(still_pending)
    db.refresh(already_succeeded)

    assert stuck_classifying.status == models.ExtractionJobStatus.failed
    assert "restarted while this job was in progress" in stuck_classifying.error_message
    assert stuck_classifying.completed_at is not None

    assert stuck_extracting.status == models.ExtractionJobStatus.failed
    assert "restarted while this job was in progress" in stuck_extracting.error_message

    # Untouched — recovery only ever targets in-progress statuses.
    assert still_pending.status == models.ExtractionJobStatus.pending
    assert already_succeeded.status == models.ExtractionJobStatus.succeeded


def test_recover_orphaned_jobs_is_a_no_op_when_nothing_is_stuck(seeded):
    assert _recover_orphaned_jobs(seeded) == 0


def test_worker_tick_processes_a_real_pending_job(seeded):
    """The happy path through _worker_tick itself (not just process_one_job
    directly, which the tests above already cover) — opens its own real
    session via SessionLocal exactly as run_forever's loop does."""
    db = seeded
    attachment = _make_attachment(db)
    job = models.ExtractionJob(
        attachment_id=attachment.id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    job_id = job.id

    assert _worker_tick() is True

    # _worker_tick did its work through its own session (app.db.SessionLocal,
    # a different connection than this test's `seeded` session) — db.get()
    # can return this test's already-cached identity-mapped object without
    # re-querying, so force an unconditional reload rather than trust it.
    db.refresh(job)
    assert job.status == models.ExtractionJobStatus.succeeded
    assert job.id == job_id

    assert _worker_tick() is False  # queue is empty now


def test_worker_tick_survives_the_database_being_completely_unreachable(monkeypatch):
    """run_forever's loop used to call process_one_job with no wrapper at
    all — if opening the session itself failed (SessionLocal() raising, e.g.
    the DB connection is down), that exception had nothing to catch it and
    took the whole worker process down. _worker_tick is the per-iteration
    unit that must survive that."""

    def _broken_session_local():
        raise RuntimeError("could not connect to the database")

    monkeypatch.setattr("app.worker.SessionLocal", _broken_session_local)

    # Must not raise, and reports "nothing processed" so run_forever sleeps
    # and retries on the next tick rather than busy-looping.
    assert _worker_tick() is False
