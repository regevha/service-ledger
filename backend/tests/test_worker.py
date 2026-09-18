"""Direct unit coverage of app/worker.py (§3) — the pieces the end-to-end
flow tests (test_document_first_flow.py, via the run_worker fixture) only
exercise on the happy path. This file drives `process_one_job` directly
against a plain db_session (no HTTP layer) to cover: the empty-queue
no-op, FIFO ordering across multiple pending jobs, and the "attachment
deleted out from under a queued job" defensive branch neither the router
nor a real user flow can trigger today (§10: there's no delete endpoint),
but that a worker crash there shouldn't ever produce silently.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app import models
from app.worker import process_one_job


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
