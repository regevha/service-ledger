"""Hebrew translation endpoints (docs: claude/proposal-hebrew-translation.md).

Submit-and-poll like classify and extract: `POST /attachments/{id}/translate`
enqueues a `translate` job (poll `GET /extraction-jobs/{id}`), the worker stores
a translation record, and a person reviews it: accept (optionally with edited
text), discard (keep using the original as today), or translate again (the
earlier record stays as history). The English text is for the screen only;
there is deliberately no route that serves it as a file.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.translation import current_translation

router = APIRouter(tags=["translations"])


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
                [models.ExtractionJobStatus.pending, models.ExtractionJobStatus.translating]
            ),
        )
        .first()
    )
    if in_flight is not None:
        raise HTTPException(409, "A translation of this document is already in progress.")

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
