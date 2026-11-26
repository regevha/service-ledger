"""Admin operations for the internal email intake demo and the draft resume state."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app import models, schemas
from app.config import get_settings
from app.db import get_db
from app.job_trigger import notify_job_queued
from app.schemas.reports import ReportSourceOut
from app.services import email_intake as intake
from app.services.duplicates import find_read_copy
from app.services.text_reader import extract_text
from app.services.translation import translation_gate

router = APIRouter(tags=["email intake"])

_DOMAIN = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")
_LOCAL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+")
_FILE_REASON = {
    "no_text": "This file has no readable text layer.",
    "unsure": "A person needs to check whether this is a service report.",
}


def _enabled() -> bool:
    settings = get_settings()
    return settings.email_intake_enabled and (settings.email_mailbox == "folder" or bool(settings.shared_password))


def _require_enabled() -> None:
    if not _enabled():
        raise HTTPException(404, "Email intake is off.")


class AllowedSenderChange(BaseModel):
    label: str

    @field_validator("label")
    @classmethod
    def clean_label(cls, value: str) -> str:
        value = value.strip()
        if not 1 <= len(value) <= 60 or "@" in value or not value.isprintable():
            raise ValueError("Use a team or role label of 1 to 60 characters.")
        return value


class AllowedSenderCreate(AllowedSenderChange):
    kind: models.IntakeAllowKind
    value: str


class AllowedSenderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    kind: models.IntakeAllowKind
    value: str
    label: str
    created_at: datetime


class EmailIntakeStatusOut(BaseModel):
    enabled: bool
    mailbox: Literal["folder", "imap"]
    sender: Literal["folder", "smtp"]
    intake_address: str | None
    max_pdfs_per_message: int
    max_pdf_megabytes: int
    poll_interval_seconds: float


class EmailLogRow(BaseModel):
    id: uuid.UUID
    received_at: datetime
    outcome: models.IntakeMessageOutcome
    reason: str | None
    file_count: int
    files_loaded: int
    files_held: int
    files_refused: int
    files_skipped: int
    sender_address: str | None
    sender_label: str | None
    reply_status: models.IntakeReplyStatus


class EmailLogPage(BaseModel):
    items: list[EmailLogRow]
    total: int


class HeldFileOut(BaseModel):
    id: uuid.UUID
    received_at: datetime
    sender_label: str | None
    reason: str
    page_count: int | None
    size_bytes: int


class ReleaseOut(BaseModel):
    report_id: uuid.UUID
    read_state: models.IntakeReadState


class IntakeStateOut(BaseModel):
    report_id: uuid.UUID
    status: models.ReportStatus
    attachment_id: uuid.UUID | None
    translation_status: str | None
    translation_required: bool
    latest_jobs: dict[models.ExtractionJobKind, schemas.ExtractionJobOut | None]
    source: ReportSourceOut | None


@router.get("/email-intake/status", response_model=EmailIntakeStatusOut)
def email_status():
    settings = get_settings()
    return EmailIntakeStatusOut(
        enabled=_enabled(),
        mailbox=settings.email_mailbox,
        sender=settings.email_sender,
        intake_address=(settings.email_intake_address or None) if _enabled() else None,
        max_pdfs_per_message=settings.email_max_pdfs_per_message,
        max_pdf_megabytes=settings.max_pdf_upload_bytes // (1024 * 1024),
        poll_interval_seconds=settings.email_poll_interval_seconds,
    )


@router.get("/email-intake/allowed-senders", response_model=list[AllowedSenderOut], dependencies=[Depends(_require_enabled)])
def list_allowed_senders(db: Session = Depends(get_db)):
    entry = models.IntakeAllowEntry
    return list(db.scalars(select(entry).order_by(entry.kind, entry.value)))


@router.post(
    "/email-intake/allowed-senders", response_model=AllowedSenderOut, status_code=201, dependencies=[Depends(_require_enabled)]
)
def add_allowed_sender(body: AllowedSenderCreate, db: Session = Depends(get_db)):
    value = body.value.strip().lower()
    if body.kind == models.IntakeAllowKind.domain:
        value = value.removeprefix("@")
        if len(value) > 253 or not _DOMAIN.fullmatch(value):
            raise HTTPException(422, "Enter a domain such as example.org.")
    else:
        local, _, domain = value.partition("@")
        if len(value) > 254 or len(local) > 64 or not _LOCAL.fullmatch(local) or not _DOMAIN.fullmatch(domain):
            raise HTTPException(422, "Enter one valid email address.")
    entry = models.IntakeAllowEntry(kind=body.kind, value=value, label=body.label)
    db.add(entry)
    try:
        db.commit()
    except IntegrityError as exc:
        if getattr(getattr(exc.orig, "diag", None), "constraint_name", None) != "uq_intake_allow_entries_value":
            raise
        raise HTTPException(409, f"This {body.kind.value} is already on the list.") from None
    db.refresh(entry)
    return entry


@router.patch(
    "/email-intake/allowed-senders/{entry_id}", response_model=AllowedSenderOut, dependencies=[Depends(_require_enabled)]
)
def change_allowed_sender(entry_id: uuid.UUID, body: AllowedSenderChange, db: Session = Depends(get_db)):
    entry = db.get(models.IntakeAllowEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "Allowed sender not found.")
    entry.label = body.label
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/email-intake/allowed-senders/{entry_id}", status_code=204, dependencies=[Depends(_require_enabled)])
def remove_allowed_sender(entry_id: uuid.UUID, db: Session = Depends(get_db)):
    entry = db.get(models.IntakeAllowEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "Allowed sender not found.")
    db.delete(entry)
    db.commit()
    return Response(status_code=204)


@router.get("/email-intake/log", response_model=EmailLogPage, dependencies=[Depends(_require_enabled)])
def email_log(
    db: Session = Depends(get_db), limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)
):
    table = models.IntakeMessage
    rows = db.scalars(
        select(table).order_by(table.received_at.desc(), table.id.desc()).options(selectinload(table.files))
        .limit(limit).offset(offset)
    ).all()
    items = []
    for row in rows:
        outcomes = [item.outcome for item in row.files]
        items.append(EmailLogRow(
            id=row.id, received_at=row.received_at, outcome=row.outcome, reason=row.reason,
            file_count=row.file_count, files_skipped=row.files_skipped,
            files_loaded=sum(x in (intake.FileOutcome.loaded, intake.FileOutcome.needs_report_type, intake.FileOutcome.released) for x in outcomes),
            files_held=sum(x in (intake.FileOutcome.held, intake.FileOutcome.held_deleted) for x in outcomes),
            files_refused=sum(x in (intake.FileOutcome.refused, intake.FileOutcome.duplicate) for x in outcomes),
            sender_address=row.sender_address, sender_label=row.sender_label, reply_status=row.reply_status,
        ))
    return EmailLogPage(items=items, total=db.scalar(select(func.count()).select_from(table)) or 0)


@router.get("/email-intake/held", response_model=list[HeldFileOut], dependencies=[Depends(_require_enabled)])
def list_held_files(db: Session = Depends(get_db)):
    table = models.IntakeFile
    files = db.scalars(
        select(table).where(table.outcome == intake.FileOutcome.held)
        .options(selectinload(table.message)).order_by(table.created_at, table.id)
    ).all()
    return [
        HeldFileOut(id=item.id, received_at=item.message.received_at, sender_label=item.message.sender_label,
                    reason=_FILE_REASON.get(item.reason_code or "", _FILE_REASON["unsure"]),
                    page_count=item.page_count, size_bytes=item.size_bytes)
        for item in files
    ]


def _get_held(db: Session, file_id: uuid.UUID, *, lock: bool = False) -> tuple[models.IntakeFile, Path]:
    table = models.IntakeFile
    query = select(table).where(table.id == file_id)
    item = db.scalar(query.with_for_update() if lock else query)
    if item is None or (not lock and item.outcome != intake.FileOutcome.held):
        raise HTTPException(404, "Held file not found.")
    if item.outcome != intake.FileOutcome.held:
        raise HTTPException(409, "This file was already released or deleted.")
    try:
        path = intake.held_path(item)
    except (ValueError, OSError):
        raise HTTPException(404, "Held file not found.") from None
    if not path.is_file():
        raise HTTPException(404, "Held file not found.")
    return item, path


@router.get("/email-intake/held/{file_id}/file", dependencies=[Depends(_require_enabled)])
def download_held_file(file_id: uuid.UUID, inline: bool = False, db: Session = Depends(get_db)):
    _, path = _get_held(db, file_id)
    return FileResponse(
        path, media_type="application/pdf", filename="held-file.pdf",
        content_disposition_type="inline" if inline else "attachment",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"},
    )


@router.post("/email-intake/held/{file_id}/release", response_model=ReleaseOut, dependencies=[Depends(_require_enabled)])
def release_held_file(file_id: uuid.UUID, db: Session = Depends(get_db)):
    item, path = _get_held(db, file_id, lock=True)
    if item.content_sha256 and find_read_copy(db, item.content_sha256):
        raise HTTPException(409, "This PDF is already in ServiceLedger.")
    contents = path.read_bytes()
    paths: list[Path] = []
    try:
        item.outcome = intake.FileOutcome.released
        item.decided_at = datetime.now(timezone.utc)
        item.held_path = None
        queued = intake.create_draft(db, item, contents, extract_text(contents), paths)
        assert item.report is not None and item.read_state is not None
        result = ReleaseOut(report_id=item.report.id, read_state=item.read_state)
        db.commit()
    except Exception:
        intake.clean_paths(paths)
        raise
    intake.clean_paths([path])
    if queued:
        notify_job_queued()
    return result


@router.delete("/email-intake/held/{file_id}", status_code=204, dependencies=[Depends(_require_enabled)])
def delete_held_file(file_id: uuid.UUID, db: Session = Depends(get_db)):
    item, path = _get_held(db, file_id, lock=True)
    item.outcome = intake.FileOutcome.held_deleted
    item.decided_at = datetime.now(timezone.utc)
    item.held_path = None
    db.commit()
    intake.clean_paths([path])
    return Response(status_code=204)


@router.get("/reports/{report_id}/intake-state", response_model=IntakeStateOut)
def report_intake_state(report_id: uuid.UUID, db: Session = Depends(get_db)):
    report = db.get(models.Report, report_id)
    if report is None:
        raise HTTPException(404, "Report not found.")
    attachment = min(report.attachments, key=lambda row: (row.created_at, row.id), default=None)
    jobs: dict[models.ExtractionJobKind, schemas.ExtractionJobOut | None] = {
        kind: None for kind in models.ExtractionJobKind
    }
    if attachment:
        for job in db.scalars(
            select(models.ExtractionJob).where(models.ExtractionJob.attachment_id == attachment.id)
            .order_by(models.ExtractionJob.started_at.desc().nulls_last(), models.ExtractionJob.id.desc())
        ):
            if jobs[job.kind] is None:
                jobs[job.kind] = schemas.ExtractionJobOut.model_validate(job)
    source = ReportSourceOut.model_validate(report.source) if report.source else None
    translation_required = bool(
        attachment and source and source.read_state == models.IntakeReadState.needs_person
        and attachment.translation_status is None and translation_gate(attachment)
    )
    return IntakeStateOut(
        report_id=report.id, status=report.status, attachment_id=attachment.id if attachment else None,
        translation_status=attachment.translation_status if attachment else None,
        translation_required=translation_required, latest_jobs=jobs, source=source,
    )
