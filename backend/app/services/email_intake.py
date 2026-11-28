"""Accept authorized PDF attachments as drafts and queue their existing report jobs."""
from __future__ import annotations

import hashlib
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path
from urllib.parse import quote, urlsplit

from sqlalchemy import delete, exists, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app import models
from app.config import Settings, get_settings
from app.services.attachment_storage import store_attachment
from app.services.attachment_types import classify_attachment
from app.services.classification_reading import report_type_from_task_code
from app.services.documents import PDF
from app.services.duplicates import find_read_copy
from app.services.email_message import UNSUBSCRIBE_SUBJECT, ParsedMessage, parse_message
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
_OPTED_OUT = "Email notifications turned off."
_READ_REPORTS = (models.ReportStatus.extracted, models.ReportStatus.in_review, models.ReportStatus.finalized)

_SERVICE = re.compile(r"\b(?:service report|field service|work order|service engineer|maintenance report|intervention report)\b", re.I)
_INSTRUMENT = re.compile(r"\b(?:instrument|cytometer|serial number|equipment|installed product)\b", re.I)
_OTHER = re.compile(r"\b(?:invoice|quotation|purchase order|curriculum vitae|resume|résumé)\b", re.I)
_REPLY_REASONS = {
    "not_pdf": "Attach a PDF file.",
    "unsupported_type": "This file type is not supported. ServiceLedger reads PDF files only; send the report as a PDF.",
    "type_mismatch": "The file type does not match the file's content, so it was not accepted. Send a fresh PDF export.",
    "too_large": "The PDF exceeds the file size limit.",
    "unsafe_pdf": "The PDF did not pass the safety checks. Send a fresh PDF export.",
    "pdf_unreadable": "This PDF could not be opened or appears incomplete. Re-export it and send the new PDF.",
    "pdf_encrypted": "This PDF is password-protected. Send an unlocked PDF.",
    "pdf_no_pages": "There are no pages in this PDF. Export the report again.",
    "pdf_too_many_pages": "This PDF has too many pages. Send only the pages of the service report.",
    "not_service_report": "This does not appear to be a service report.",
    "already_on_file": "This PDF is already in ServiceLedger.",
    "already_in_message": "This PDF was already listed in this email.",
    "no_text": "This PDF has no readable text layer and is held for review. If available, send a PDF with selectable text.",
    "unsure": "The file needs a check to confirm it is a service report.",
}
_PDF_REFUSAL_CODES = {
    "truncated": "pdf_unreadable",
    "unreadable": "pdf_unreadable",
    "unreadable_page": "pdf_unreadable",
    "damaged_object": "pdf_unreadable",
    "encrypted": "pdf_encrypted",
    "no_pages": "pdf_no_pages",
    "too_many_pages": "pdf_too_many_pages",
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
    if message.reply_status == ReplyStatus.pending:
        hint = _receipt_type_hint(document_text)
        intake_file.receipt_type_hint = hint.value if hint else None
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
    if service and _INSTRUMENT.search(document_text) and _receipt_type_hint(document_text):
        if any(re.search(rf"(?<!\w){re.escape(model)}(?!\w)", document_text, re.IGNORECASE) for model in model_names if model):
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
    if (incoming.raw is not None and not parsed.parts_limit_reached
            and (parsed.reply_subject or "").casefold() == UNSUBSCRIBE_SUBJECT.casefold()
            and not any(part.data.startswith(b"%PDF-") for part in parsed.attachments)):
        return MessageOutcome.no_pdf, allowed, _OPTED_OUT
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

    address = parsed.from_address
    unsubscribe = reason == _OPTED_OUT
    if unsubscribe and address is not None:
        db.execute(insert(models.IntakeNotificationOptOut).values(address=address).on_conflict_do_nothing())
    send_reply = allowed is not None and address is not None and not unsubscribe and (
        db.get(models.IntakeNotificationOptOut, address) is None
    )
    message = models.IntakeMessage(
        message_key=key,
        received_at=incoming.received_at,
        sender_address=parsed.from_address if allowed else None,
        sender_label=allowed.label if allowed else None,
        outcome=outcome,
        reason=reason,
        file_count=len(parsed.attachments),
        reply_status=ReplyStatus.pending if send_reply else ReplyStatus.none,
        reply_subject=parsed.reply_subject if send_reply else None,
        reply_to_message_id=parsed.reply_to_message_id if send_reply else None,
    )
    db.add(message)
    db.flush()
    if outcome != MessageOutcome.processed:
        return False

    model_names = list(db.scalars(select(models.InstrumentModel.name)))
    hashes: set[str] = set()
    pdf_count = 0
    other_count = 0
    queued = False
    for part in parsed.attachments:
        # The type comes from the bytes, never from the file name or the declared
        # content type. Anything that is not a readable type stops here, before
        # it is hashed, parsed or stored. Only a bounded number of such files get
        # a row, so a message full of junk cannot fill the log.
        type_verdict = classify_attachment(part.data, part.declared_type)
        if not type_verdict.supported:
            other_count += 1
            if other_count > settings.email_max_other_files_per_message:
                message.files_skipped += 1
                continue
            db.add(models.IntakeFile(
                message=message,
                position=part.position,
                size_bytes=part.size_bytes,
                outcome=FileOutcome.refused,
                reason_code=type_verdict.reason_code,
                receipt_filename=part.receipt_name if send_reply else None,
            ))
            continue
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
            receipt_filename=part.receipt_name if send_reply else None,
        )
        db.add(intake_file)
        if not verdict.ok:
            intake_file.reason_code = _PDF_REFUSAL_CODES.get(verdict.detail or "", verdict.status)
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


def _receipt_items(message: models.IntakeMessage, max_pdf_bytes: int) -> list[tuple[str, str, models.IntakeFile | None]]:
    items = []
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
        items.append((f"Attachment {entry.position}", status, entry))
    if message.files_skipped:
        items.append(("File limit", f"Attachments skipped because the message exceeded the file count limit: {message.files_skipped}.", None))
    if message.reason:
        items.append(("Email result", message.reason, None))
    return items


def _receipt_type_hint(document_text: str) -> models.ReportType | None:
    candidates = set()
    if re.search(r"^\s*Preventive Maintenance\s*$", document_text, re.IGNORECASE | re.MULTILINE):
        candidates.add(models.ReportType.preventive_maintenance)
    if re.search(r"^\s*Corrective Repair(?: / Troubleshooting Visit)?\s*$", document_text, re.IGNORECASE | re.MULTILINE):
        candidates.add(models.ReportType.repair)
    if re.search(r"\bBD\b", document_text):
        if kind := report_type_from_task_code(read_identifiers(document_text, []).task_code):
            candidates.add(kind)
    return next(iter(candidates)) if len(candidates) == 1 else None


_REPORT_TYPE_LABELS = {
    models.ReportType.repair: "Repair",
    models.ReportType.preventive_maintenance: "Preventive maintenance",
    models.ReportType.installation_upgrade: "Installation or upgrade",
}


def _receipt_report_base(settings: Settings) -> str | None:
    base = settings.email_report_base_url.strip().rstrip("/")
    if not base or "\\" in base or any(char.isspace() for char in base):
        return None
    try:
        url = urlsplit(base)
        if not url.hostname or url.username is not None or url.query or url.fragment:
            return None
        if url.scheme == "https" and settings.shared_password:
            return base
        if (settings.local_imap_without_password and url.scheme in {"http", "https"}
                and url.hostname in {"localhost", "127.0.0.1", "::1"}):
            return base
    except ValueError:
        pass
    return None


def compose_receipt(message: models.IntakeMessage, settings: Settings) -> tuple[str, str, str]:
    base = _receipt_report_base(settings)
    unsubscribe = f"mailto:{quote(settings.email_intake_address, safe='@')}?subject={quote(UNSUBSCRIBE_SUBJECT)}"
    plain = ["ServiceLedger | Email receipt", ""]
    cards = []
    for title, status, entry in _receipt_items(message, settings.max_pdf_upload_bytes):
        plain.append(f"{title}: {status}")
        filename = entry.receipt_filename if entry else None
        if filename:
            plain.append(f"File: {filename}")
        details = []
        link = None
        if entry is not None:
            if entry.page_count is not None:
                details.append(f"Pages: {entry.page_count}")
            if entry.report is not None:
                report = entry.report
                template = report.template
                if template:
                    details.append(f"Report type: {_REPORT_TYPE_LABELS[template.report_type]}")
                elif entry.receipt_type_hint:
                    details.append(f"Suggested report type: {_REPORT_TYPE_LABELS[models.ReportType(entry.receipt_type_hint)]}")
                else:
                    details.append("Report type: awaiting classification or review")
                if report.instrument and report.instrument.model:
                    details.append(f"Instrument model: {report.instrument.model}")
                if report.report_date:
                    details.append(f"Service date: {report.report_date.isoformat()}")
                if base:
                    link = f"{base}/#/reports/{report.id}"
        plain.extend(details)
        if link:
            plain.append(f"Open report to review, edit or approve: {link}")
        plain.append("")
        metadata = f'<p style="margin:6px 0;color:#566074">{escape(" · ".join(details))}</p>' if details else ""
        file_label = f'<p style="margin:6px 0;overflow-wrap:anywhere"><strong>{escape(filename)}</strong></p>' if filename else ""
        button = (f'<p style="margin:12px 0 0"><a href="{escape(link, quote=True)}" '
                  'style="display:inline-block;background:#3b4fb8;color:#fff;padding:10px 14px;border-radius:8px;'
                  'text-decoration:none;font-weight:bold">Open report</a></p>') if link else ""
        cards.append(f'<div style="margin:0 0 12px;padding:16px;background:#fff;border:1px solid #dde2ec;'
                     f'border-radius:10px"><strong>{escape(title)}</strong>{file_label}<p style="margin:6px 0">'
                     f'{escape(status)}</p>{metadata}{button}</div>')
    plain.append(f"Unsubscribe from email notifications (send the prepared email): {unsubscribe}")
    html = (
        '<html lang="en"><body style="margin:0;background:#f4f6fa;color:#1b2230;font:15px Arial,sans-serif">'
        '<div style="max-width:580px;margin:0 auto;padding:24px">'
        '<p style="margin:0 0 8px;color:#2c3b8f;font-weight:bold">ServiceLedger</p>'
        '<h1 style="margin:0 0 20px;font-size:25px">Email receipt</h1>'
        + "".join(cards)
        + '<p style="margin:20px 0 0;color:#566074;font-size:13px">'
        + f'<a style="color:#2c3b8f" href="{escape(unsubscribe, quote=True)}">Unsubscribe from email notifications</a>'
        + ' by sending the prepared email.</p></div></body></html>'
    )
    return "\n".join(plain) + "\n", html, unsubscribe


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
