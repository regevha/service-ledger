from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app import models, schemas
from app.config import get_settings
from app.db import get_db
from app.services.classification import classify as run_classify
from app.services.errors import ClassificationError, ExtractionError
from app.services.extraction import extract as run_extract

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
    dest = report_dir / f"{uuid.uuid4()}_{file.filename}"
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


@router.post("/attachments/{attachment_id}/classify", response_model=schemas.ClassificationResult)
def classify_attachment(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """§4 step 3 / §9: guess instrument and report type, resolve a template
    when confident. Swap `services.classification.classify` for a real
    Claude vision call to make this live — nothing here changes."""
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")

    try:
        result = run_classify(db, attachment)
    except ClassificationError as e:
        # Record the attempt even though it failed — a 500 with no trace of
        # what was tried leaves a technician unable to tell "classification
        # failed" from "nothing happened yet."
        job = models.ExtractionJob(
            attachment_id=attachment_id,
            status=models.ExtractionJobStatus.failed,
            error_message=str(e),
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
        )
        db.add(job)
        db.commit()
        raise HTTPException(502, f"Classification failed: {e}") from e

    job = models.ExtractionJob(
        attachment_id=attachment_id,
        status=models.ExtractionJobStatus.pending,
        classification=result.model_dump(mode="json"),
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)

    report = attachment.report
    if result.resolved_instrument_id and result.resolved_template_id:
        # Confident on both — resolve automatically and move straight
        # toward extraction (§4: "the system resolves the matching template
        # automatically and moves straight to extraction").
        report.instrument_id = result.resolved_instrument_id
        report.template_id = result.resolved_template_id
        report.status = models.ReportStatus.classified
        job.status = models.ExtractionJobStatus.succeeded
        job.completed_at = datetime.now(timezone.utc)
    else:
        # Below threshold on either guess — leave instrument/template NULL;
        # the technician (or a caller) must PATCH /reports/{id}/template
        # with a manual pick before extraction can run (§4's fallback path).
        job.status = models.ExtractionJobStatus.succeeded
        job.completed_at = datetime.now(timezone.utc)

    db.commit()
    return result


@router.post("/attachments/{attachment_id}/extract", response_model=schemas.ExtractionJobOut)
def extract_attachment(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """§4 step 4-5 / §9: enqueue (here, run inline — there's no real
    background worker in this scaffold yet, see §3) an extraction job against
    the report's resolved template. Swap `services.extraction.extract` for a
    real Claude vision call to make this live."""
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    report = attachment.report
    if not report.template_id or not report.instrument_id:
        raise HTTPException(
            409, "Report has no resolved instrument/template yet — classify the attachment and confirm a template first (§4)."
        )
    template = db.get(models.ReportTemplate, report.template_id)

    job = models.ExtractionJob(
        attachment_id=attachment_id,
        status=models.ExtractionJobStatus.extracting,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)

    try:
        extracted_fields, field_confidences = run_extract(attachment, template)
    except ExtractionError as e:
        job.status = models.ExtractionJobStatus.failed
        job.error_message = str(e)
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(502, f"Extraction failed: {e}") from e

    report.extracted_fields = extracted_fields
    report.status = models.ReportStatus.extracted
    job.field_confidences = field_confidences
    job.status = models.ExtractionJobStatus.succeeded
    job.completed_at = datetime.now(timezone.utc)

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
