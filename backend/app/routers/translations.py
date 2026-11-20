"""Hebrew translation endpoints (docs: claude/proposal-hebrew-translation.md).

Submit-and-poll like classify and extract: `POST /attachments/{id}/translate`
enqueues a `translate` job (poll `GET /extraction-jobs/{id}`), the worker stores
a translation record, and its review setting determines whether it is used
immediately or shown for review. Reviewers can accept, edit, discard, or
translate again. The English text is for the screen only;
there is deliberately no route that serves it as a file.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.job_limits import enforce_job_limits
from app.services.translation import current_translation

logger = logging.getLogger(__name__)

router = APIRouter(tags=["translations"])
settings_router = APIRouter(prefix="/admin", tags=["admin"])


class TranslationReviewSetting(BaseModel):
    show_translation_review: bool


@settings_router.get("/translation-review", response_model=TranslationReviewSetting)
def get_translation_review_setting(db: Session = Depends(get_db)):
    settings = db.get(models.ReportIntakeSettings, 1)
    return TranslationReviewSetting(
        show_translation_review=settings.show_translation_review if settings else True,
    )


@settings_router.put("/translation-review", response_model=TranslationReviewSetting)
def update_translation_review_setting(payload: TranslationReviewSetting, db: Session = Depends(get_db)):
    statement = insert(models.ReportIntakeSettings).values(
        id=1, show_translation_review=payload.show_translation_review,
    )
    db.execute(statement.on_conflict_do_update(
        index_elements=[models.ReportIntakeSettings.id],
        set_={"show_translation_review": statement.excluded.show_translation_review},
    ))
    db.commit()
    return payload


def _get_attachment(db: Session, attachment_id: uuid.UUID) -> models.Attachment:
    attachment = db.get(models.Attachment, attachment_id)
    if not attachment:
        raise HTTPException(404, "Attachment not found")
    return attachment


@router.post(
    "/attachments/{attachment_id}/translate",
    response_model=schemas.ExtractionJobOut,
    status_code=202,
)
def translate_attachment(
    attachment_id: uuid.UUID,
    payload: schemas.TranslateRequest | None = None,
    db: Session = Depends(get_db),
):
    """Enqueue a translate job. Also the way to translate again, or to ask for
    pages that were skipped as QC printouts to be included (`include_pages`)."""
    attachment = _get_attachment(db, attachment_id)
    if attachment.report.status == models.ReportStatus.finalized:
        raise HTTPException(409, "Cannot translate an attachment on a finalized report.")
    in_flight = (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.attachment_id == attachment_id,
            models.ExtractionJob.kind == models.ExtractionJobKind.translate,
            models.ExtractionJob.status.in_(
                [
                    models.ExtractionJobStatus.pending,
                    models.ExtractionJobStatus.translating,
                    models.ExtractionJobStatus.awaiting_approval,
                ]
            ),
        )
        .first()
    )
    if in_flight is not None:
        raise HTTPException(409, "A translation of this document is already in progress.")
    enforce_job_limits(db, attachment_id, models.ExtractionJobKind.translate)

    job = models.ExtractionJob(
        attachment_id=attachment_id,
        kind=models.ExtractionJobKind.translate,
        status=models.ExtractionJobStatus.pending,
        params={"include_pages": payload.include_pages} if payload and payload.include_pages else None,
        started_at=datetime.now(timezone.utc),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    logger.info("Queued %s job %s for attachment %s", job.kind.value, job.id, attachment_id)
    return job


@router.get("/attachments/{attachment_id}/translation", response_model=schemas.TranslationOut)
def get_current_translation(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """The attachment's current translation: the newest one that is not superseded."""
    attachment = _get_attachment(db, attachment_id)
    current = current_translation(attachment)
    if current is None:
        raise HTTPException(404, "This document has no translation")
    return current


@router.get("/attachments/{attachment_id}/translations", response_model=list[schemas.TranslationOut])
def list_translations(attachment_id: uuid.UUID, db: Session = Depends(get_db)):
    """Every translation of the attachment, newest first (history included)."""
    attachment = _get_attachment(db, attachment_id)
    return list(reversed(attachment.translations))


def _get_reviewable(db: Session, translation_id: uuid.UUID) -> models.Translation:
    translation = db.get(models.Translation, translation_id, with_for_update=True)
    if not translation:
        raise HTTPException(404, "Translation not found")
    if translation.attachment.report.status == models.ReportStatus.finalized:
        raise HTTPException(409, "The report is finalized; its translation can no longer be changed.")
    return translation


@router.post("/translations/{translation_id}/accept", response_model=schemas.TranslationOut)
def accept_translation(
    translation_id: uuid.UUID,
    payload: schemas.TranslationAccept | None = None,
    db: Session = Depends(get_db),
):
    """Accept the translation as the document's English text, with the reviewer's
    edits if `accepted_text` is sent. Both texts are kept. Classification and
    extraction read the accepted text from now on."""
    translation = _get_reviewable(db, translation_id)
    if translation.status != models.TranslationStatus.pending_review:
        raise HTTPException(409, f"Only a translation waiting for review can be accepted (this one is {translation.status.value}).")
    translation.accepted_text = payload.accepted_text if payload and payload.accepted_text is not None else translation.model_text
    translation.status = models.TranslationStatus.accepted
    translation.accepted_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(translation)
    return translation


@router.post("/translations/{translation_id}/discard", response_model=schemas.TranslationOut)
def discard_translation(translation_id: uuid.UUID, db: Session = Depends(get_db)):
    """Drop the translation and go on with the original document as before."""
    translation = _get_reviewable(db, translation_id)
    if translation.status not in (models.TranslationStatus.pending_review, models.TranslationStatus.accepted):
        raise HTTPException(409, f"This translation is {translation.status.value} and cannot be discarded.")
    translation.status = models.TranslationStatus.discarded
    db.commit()
    db.refresh(translation)
    return translation
