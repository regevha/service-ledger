from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app import models, schemas
from app.config import get_settings
from app.db import get_db

router = APIRouter(tags=["attachments"])
settings = get_settings()


@router.post("/reports/{report_id}/attachments", response_model=schemas.AttachmentOut, status_code=201)
async def upload_attachment(report_id: uuid.UUID, file: UploadFile, db: Session = Depends(get_db)):
    """§4 step 1 / §9: upload a scanned original. The only entry path for
    MVP (§4) — there is no blank-form fallback."""
    report = db.get(models.Report, report_id)
    if not report:
        raise HTTPException(404, "Report not found")

    report_dir = settings.attachment_storage_path / str(report_id)
    report_dir.mkdir(parents=True, exist_ok=True)
    # file.filename is entirely client-controlled — whatever name the
    # uploader's browser/script sends, verbatim. Path(...).name strips any
    # directory components (a "/" anywhere, a leading "/" for an absolute
    # path, "../" traversal segments) down to the last path component before
    # it ever reaches the filesystem, and falls back to a fixed name for the
    # edge cases that have no usable name at all (no filename sent, or one
    # that's just "." / ".." / empty after stripping). Previously, any
    # filename containing "/" (e.g. "Scans/2024/report.pdf" from a
    # nested-folder upload) embedded that slash as an extra, non-existent
    # path segment below report_dir — write_bytes() then raised an unhandled
    # FileNotFoundError, a hard 500 for what should just be an upload with an
    # unusual name (confirmed via proof-of-concept during a file-handling
    # security review; it never achieved a real path-traversal write, since
    # the "<uuid>_" prefix glued onto the filename happened to turn a leading
    # "../" into a literal, nonexistent directory name rather than a real
    # parent reference — but crashing on ordinary-looking input is still a
    # bug worth closing outright, independent of how it failed).
    # Path(...).name on a bare "." or ".." returns the string unchanged (it
    # only blanks out to "" for "", "/", or a path that *ends* in a trailing
    # slash) — so those two need an explicit check, not just an `or "upload"`
    # fallback on emptiness, to land on a real, unambiguous filename instead
    # of a technically-harmless-but-confusing "<uuid>_.." on disk.
    raw_name = Path(file.filename or "").name
    safe_filename = raw_name if raw_name not in ("", ".", "..") else "upload"
    dest = report_dir / f"{uuid.uuid4()}_{safe_filename}"
    contents = await file.read()
    dest.write_bytes(contents)

    attachment = models.Attachment(
        report_id=report_id,
        file_path=str(dest),
        file_type=file.content_type or "application/octet-stream",
        page_count=1,  # TODO: compute real page count once PDF preprocessing (§4 step 2) is wired in.
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return attachment


@router.get("/attachments/{attachment_id}/file")
def get_attachment_file(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """Serves the original scanned file back byte-for-byte off local disk
    (§8: local disk for MVP) — the report screen's "View original scan"
    link. Nothing here re-derives, re-encodes, or previews the file; it's
    the same bytes upload_attachment wrote, so a technician can always check
    the review screen's extracted values against the actual scan."""
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")

    path = Path(attachment.file_path)
    if not path.exists():
        # Genuinely seen in practice with the stub-mode E2E/demo databases,
        # which get reseeded independently of storage/attachments/ on disk —
        # a stale attachment row can outlive its file. Distinct from a
        # missing row (404 above) so this is diagnosable rather than looking
        # like a bad attachment_id.
        raise HTTPException(404, "Attachment file is missing from storage")

    # Strip the "<uuid>_" prefix upload_attachment added to dedupe filenames
    # on disk, so the browser's download/save-as dialog shows the
    # technician's own original filename rather than a UUID-prefixed one.
    original_name = path.name.split("_", 1)[1] if "_" in path.name else path.name
    return FileResponse(path, media_type=attachment.file_type or "application/octet-stream", filename=original_name)


@router.post(
    "/attachments/{attachment_id}/classify",
    response_model=schemas.ExtractionJobOut,
    status_code=202,
)
def classify_attachment(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """§4 step 3 / §9 / §3: enqueue a classify job and return immediately —
    `app.worker` is what actually calls Claude and resolves a template when
    confident. This used to run `services.classification.classify` inline in
    the request; §3 is explicit that a vision call ("seconds, not
    milliseconds") shouldn't block an HTTP request, so this endpoint's only
    job now is validating the attachment exists and handing the worker a row
    to pick up. Poll `GET /extraction-jobs/{id}` on the returned job until its
    `status` leaves `pending`/`classifying`."""
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")

    job = models.ExtractionJob(
        attachment_id=attachment_id,
        kind=models.ExtractionJobKind.classify,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.post(
    "/attachments/{attachment_id}/extract",
    response_model=schemas.ExtractionJobOut,
    status_code=202,
)
def extract_attachment(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """§4 step 4-5 / §9 / §3: enqueue an extract job against the report's
    already-resolved template and return immediately — `app.worker` runs the
    actual Claude vision call asynchronously. The 409 here is still checked
    synchronously (a report with no resolved template is a client mistake to
    reject up front, not something worth a round trip through the queue to
    discover); the worker re-checks the same condition defensively before it
    runs (see `app.worker._run_extract_job`)."""
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    report = attachment.report
    if not report.template_id or not report.instrument_id:
        raise HTTPException(
            409, "Report has no resolved instrument/template yet — classify the attachment and confirm a template first (§4)."
        )

    job = models.ExtractionJob(
        attachment_id=attachment_id,
        kind=models.ExtractionJobKind.extract,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.get("/extraction-jobs/{job_id}", response_model=schemas.ExtractionJobOut)
def get_extraction_job(job_id: uuid.UUID, db: Session = Depends(get_db)):
    """§9: poll job status, classification result, and per-field confidence."""
    job = db.get(models.ExtractionJob, job_id)
    if not job:
        raise HTTPException(404, "Extraction job not found")
    return job
