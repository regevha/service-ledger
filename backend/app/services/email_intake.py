"""Accept authorized PDF attachments as drafts and queue their existing report jobs."""
from __future__ import annotations

import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sqlalchemy import delete, exists, select
from sqlalchemy.orm import Session

from app import models
from app.config import Settings, get_settings
from app.services.attachment_storage import store_attachment
from app.services.documents import PDF
from app.services.duplicates import find_read_copy
from app.services.email_message import ParsedMessage, parse_message
from app.services.job_limits import find_unfinished_job, job_limit
from app.services.mailbox import RawMessage
from app.services.pdf_safety import check_pdf
from app.services.text_reader import extract_text, read_identifiers
from app.services.translation import translation_gate

logger = logging.getLogger(__name__)
FileOutcome = models.IntakeFileOutcome
MessageOutcome = models.IntakeMessageOutcome
ReadState = models.IntakeReadState
ReplyStatus = models.IntakeReplyStatus
JobKind = models.ExtractionJobKind
_READ_REPORTS = (models.ReportStatus.extracted, models.ReportStatus.in_review, models.ReportStatus.finalized)

_SERVICE = re.compile(r"\b(?:service report|field service|work order|service engineer|maintenance report|intervention report)\b", re.I)
_INSTRUMENT = re.compile(r"\b(?:instrument|cytometer|serial number|equipment|installed product)\b", re.I)
_OTHER = re.compile(r"\b(?:invoice|quotation|purchase order|curriculum vitae|resume|résumé)\b", re.I)
_REPLY_REASONS = {
    "not_pdf": "Attach a PDF file.",
    "too_large": "The PDF exceeds the file size limit.",
    "unsafe_pdf": "The PDF could not be accepted.",
    "not_service_report": "This does not appear to be a service report.",
    "already_on_file": "This PDF is already in ServiceLedger.",
    "already_in_message": "This PDF was already listed in this email.",
    "no_text": "The file needs a check because it has no readable text layer.",
    "unsure": "The file needs a check to confirm it is a service report.",
}


def find_sender(db: Session, address: str) -> models.IntakeAllowEntry | None:
    allowed = db.scalar(select(models.IntakeAllowEntry).where(models.IntakeAllowEntry.value == address))
    if allowed is not None:
        return allowed
    domain = address.rsplit("@", 1)[-1]
    return db.scalar(
        select(models.IntakeAllowEntry).where(
            models.IntakeAllowEntry.value == domain,
            models.IntakeAllowEntry.kind == models.IntakeAllowKind.domain,
        )
    )


def queue_read(
    db: Session, intake_file: models.IntakeFile, attachment: models.Attachment, kind: models.ExtractionJobKind
) -> bool:
    """Make a guarded queue entry in the caller's transaction, or retain a state for retry."""
    intake_file.waiting_kind = None
    if find_unfinished_job(db, attachment.id, kind):
        intake_file.read_state = ReadState.queued
        return False
    if translation_gate(attachment):
        intake_file.read_state = ReadState.needs_person
        return False
    if limit := job_limit(db, attachment.id, kind):
        intake_file.read_state = ReadState.waiting_for_limit if limit[0] == "daily" else ReadState.needs_person
        if intake_file.read_state == ReadState.waiting_for_limit:
            intake_file.waiting_kind = kind
        return False
    intake_file.read_state = ReadState.queued
    db.add(models.ExtractionJob(
        attachment_id=attachment.id,
        kind=kind,
        status=models.ExtractionJobStatus.pending,
        started_at=datetime.now(timezone.utc),
        params={"auto_extract": True},
    ))
    return True


def create_draft(
    db: Session,
    intake_file: models.IntakeFile,
    contents: bytes,
    document_text: str,
    written_paths: list[Path],
) -> bool:
    """Create one draft and copy the sender attribution beside its report fields."""
    message = intake_file.message
    report = models.Report()
    db.add(report)
    db.flush()
    attachment, path = store_attachment(
        db, report.id, contents, PDF, f"emailed-report-{intake_file.position}.pdf",
        pdf_pages=intake_file.page_count, pdf_text=document_text,
    )
    written_paths.append(path)
    intake_file.report = report
    report.source = models.ReportSource(
        channel=models.ReportSourceChannel.email,
        sender_address=message.sender_address,
        sender_label=message.sender_label,
        received_at=message.received_at,
        intake_file=intake_file,
    )
    db.flush()
    if intake_file.outcome == FileOutcome.needs_report_type:
        intake_file.read_state = ReadState.needs_person
        return False
    return queue_read(db, intake_file, attachment, JobKind.classify)


def _relevance(document_text: str, model_names: list[str]) -> tuple[models.IntakeFileOutcome, str | None]:
    service = _SERVICE.search(document_text)
    if _OTHER.search(document_text) and not service:
        return FileOutcome.refused, "not_service_report"
    identifiers = read_identifiers(document_text, model_names)
    if identifiers.task_code and identifiers.in_bd_format:
        return FileOutcome.loaded, None
    if service and _INSTRUMENT.search(document_text):
        return FileOutcome.needs_report_type, None
    return FileOutcome.held, "unsure" if document_text.strip() else "no_text"


def held_path(intake_file: models.IntakeFile) -> Path:
    if not intake_file.held_path:
        raise ValueError("Held file has no stored path")
    directory = get_settings().attachment_storage_path / "email-held"
    path = (directory / Path(intake_file.held_path).name).resolve()
    if path.parent != directory.resolve():
        raise ValueError("Held path leaves the intake directory")
    return path


def clean_paths(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not remove a staged email intake file.")


def _is_self_reply(parsed: ParsedMessage, settings: Settings) -> bool:
    return parsed.is_auto_reply or (
        bool(parsed.from_address) and parsed.from_address == settings.email_intake_address.strip().lower()
    )


def _message_result(
    db: Session, parsed: ParsedMessage, incoming: RawMessage, settings: Settings
) -> tuple[models.IntakeMessageOutcome, models.IntakeAllowEntry | None, str | None]:
    if _is_self_reply(parsed, settings):
        return MessageOutcome.auto_reply_ignored, None, "Automated email ignored."
    if settings.email_mailbox == "imap" and parsed.sender_verified is not True:
        return MessageOutcome.sender_not_verified, None, "Sender could not be verified."
    allowed = find_sender(db, parsed.from_address) if parsed.from_address else None
    if not allowed:
        if incoming.raw is None and not parsed.from_address:
            return MessageOutcome.too_large, None, "Message exceeded the download limit."
        return MessageOutcome.unknown_sender, None, "Sender is not on the allow list."
    window = datetime.now(timezone.utc) - timedelta(hours=1)
    prior = db.scalars(
        select(models.IntakeMessage.id).where(
            models.IntakeMessage.sender_address == parsed.from_address,
            models.IntakeMessage.handled_at >= window,
            models.IntakeMessage.outcome != MessageOutcome.rate_limited,
        ).limit(settings.email_max_messages_per_sender_per_hour)
    ).all()
    if len(prior) >= settings.email_max_messages_per_sender_per_hour:
        return MessageOutcome.rate_limited, None, "Hourly sender limit reached."
    if incoming.raw is None or parsed.too_large:
        return MessageOutcome.too_large, allowed, "Message exceeded the download limit."
    if parsed.unreadable:
        return MessageOutcome.error, allowed, "Message could not be read."
    if not parsed.attachments:
        return MessageOutcome.no_pdf, allowed, "Attach at least one service report PDF."
    return MessageOutcome.processed, allowed, None


def process_message(db: Session, incoming: RawMessage, settings: Settings, written_paths: list[Path]) -> bool:
    """Write the outcomes for one message. The poller commits before acknowledging it."""
    raw = incoming.raw if incoming.raw is not None else incoming.headers
    trusted_auth = settings.email_trusted_authserv_id if settings.email_mailbox == "imap" else None
    parsed = parse_message(raw or b"", trusted_authserv_id=trusted_auth, max_message_bytes=settings.email_max_message_bytes)
    outcome, allowed, reason = _message_result(db, parsed, incoming, settings)
    if incoming.raw is None or not parsed.message_key:
        key = hashlib.sha256(f"{incoming.ref}:{incoming.received_at.isoformat()}".encode()).hexdigest()
    else:
        key = parsed.message_key
    # Unverified copies cannot prevent subsequent verified delivery of the message.
    if not allowed and outcome != MessageOutcome.rate_limited:
        key = hashlib.sha256(f"ignored:{key}".encode()).hexdigest()
    if db.scalar(select(models.IntakeMessage.id).where(models.IntakeMessage.message_key == key)) is not None:
        return False

    message = models.IntakeMessage(
        message_key=key,
        received_at=incoming.received_at,
        sender_address=parsed.from_address if allowed else None,
        sender_label=allowed.label if allowed else None,
        outcome=outcome,
        reason=reason,
        file_count=len(parsed.attachments),
        reply_status=ReplyStatus.pending if allowed else ReplyStatus.none,
    )
    db.add(message)
    db.flush()
    if outcome != MessageOutcome.processed:
        return False

    model_names = list(db.scalars(select(models.InstrumentModel.name)))
    hashes: set[str] = set()
    pdf_count = 0
    queued = False
    for part in parsed.attachments:
        is_pdf = part.data.startswith(b"%PDF-")
        if is_pdf:
            pdf_count += 1
            if pdf_count > settings.email_max_pdfs_per_message:
                message.files_skipped += 1
                continue
        verdict = check_pdf(part.data, settings.max_pdf_upload_bytes)
        intake_file = models.IntakeFile(
            message=message,
            position=part.position,
            size_bytes=part.size_bytes,
            page_count=verdict.page_count,
            outcome=FileOutcome.refused,
        )
        db.add(intake_file)
        if not verdict.ok:
            intake_file.reason_code = verdict.status
            continue
        intake_file.content_sha256 = part.sha256
        if intake_file.content_sha256 in hashes:
            intake_file.outcome, intake_file.reason_code = FileOutcome.duplicate, "already_in_message"
            continue
        hashes.add(intake_file.content_sha256)
        if find_read_copy(db, intake_file.content_sha256):
            intake_file.outcome, intake_file.reason_code = FileOutcome.duplicate, "already_on_file"
            continue

        document_text = extract_text(part.data)
        intake_file.outcome, intake_file.reason_code = _relevance(document_text, model_names)
        if intake_file.outcome == FileOutcome.held:
            intake_file.held_path = f"email-held/{uuid.uuid4().hex}.pdf"
            path = held_path(intake_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            written_paths.append(path)
            path.write_bytes(part.data)
        elif intake_file.outcome in (FileOutcome.loaded, FileOutcome.needs_report_type):
            if create_draft(db, intake_file, part.data, document_text, written_paths):
                queued = True
    if not pdf_count:
        message.outcome = MessageOutcome.no_pdf
        message.reason = "Attach at least one service report PDF."
    if parsed.parts_limit_reached:
        message.reason = "Some attachments were skipped because the message had too many parts."
    return queued


def reply_body(message: models.IntakeMessage, max_pdf_bytes: int) -> str:
    lines = []
    for entry in message.files:
        if entry.outcome in (FileOutcome.loaded, FileOutcome.needs_report_type):
            if entry.read_state == ReadState.waiting_for_limit:
                status = "Received. Reading will resume when the daily limit allows."
            elif entry.read_state == ReadState.needs_person:
                status = "Received as a draft. It needs a check in ServiceLedger."
            else:
                status = "Received as a draft for review in ServiceLedger."
        elif entry.reason_code == "too_large":
            status = f"The PDF exceeds the {max_pdf_bytes // (1024 * 1024)} MB file size limit."
        else:
            status = _REPLY_REASONS.get(entry.reason_code or "", "The file could not be accepted.")
        lines.append(f"Attachment {entry.position}: {status}")
    if message.files_skipped:
        lines.append(f"PDFs skipped because the message exceeded the file count limit: {message.files_skipped}.")
    if message.reason:
        lines.append(message.reason)
    return "\n".join(lines) + "\n"


def retry_waiting(db: Session) -> bool:
    queued = False
    waiting = db.scalars(
        select(models.IntakeFile)
        .where(models.IntakeFile.read_state == ReadState.waiting_for_limit)
        .order_by(models.IntakeFile.created_at, models.IntakeFile.id)
        .limit(100).with_for_update(skip_locked=True)
    ).all()
    for intake_file in waiting:
        kind = intake_file.waiting_kind
        report = intake_file.report
        if report is None or not report.attachments or report.status in _READ_REPORTS or kind is None:
            intake_file.waiting_kind = None
            intake_file.read_state = ReadState.needs_person
            continue
        if queue_read(db, intake_file, report.attachments[0], kind):
            # The session does not autoflush and the next capacity check must count this job.
            db.flush()
            queued = True
        elif intake_file.read_state == ReadState.waiting_for_limit:
            break
    return queued


def prune_log(db: Session, retention_days: int) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    active = exists().where(
        models.IntakeFile.message_id == models.IntakeMessage.id,
        (models.IntakeFile.outcome == FileOutcome.held)
        | models.IntakeFile.read_state.in_((ReadState.waiting_for_limit, ReadState.queued)),
    )
    db.execute(
        delete(models.IntakeMessage).where(
            models.IntakeMessage.handled_at < cutoff,
            models.IntakeMessage.reply_status != ReplyStatus.pending,
            ~active,
        )
    )
