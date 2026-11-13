"""Email intake: the allow list, the message log, one row per attachment, and where a report came from.

See docs/features/email-intake/DATA_MODEL.md. Four tables, because:
- the allow list must live in the database and be edited by admins (AC-20, AC-32);
- the admin log keeps one row per email with no content, and dedupes by message key (AC-12, AC-18);
- each attachment has its own outcome, and held files are listed from it (AC-02, AC-10, AC-26);
- where a report came from is stored beside the report, not in a report field (AC-27, R-15), and is a
  copy, so it survives log pruning and allow-list edits (AC-30).

Privacy (AC-12, AC-24, AC-25): no email body, subject, attachment name, Reply-To, raw header or raw
Message-ID is stored anywhere here. A sender address is stored only when the sender matched the allow
list; CHECK constraints below make the database refuse an address on an unknown or unverified sender's row.

Every index and constraint is declared here as well as in the migration, because tests build the
tables with `create_all` and CI runs `alembic check`.
"""
import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ENUM, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

from .enums import ExtractionJobKind, _uuid_pk

if TYPE_CHECKING:
    from .reports import Report

# Lengths shared with the API's validation (services/allow_list.py): an address is at most 254
# characters (RFC 5321), a label at most 60.
ADDRESS_MAX_LENGTH = 254
LABEL_MAX_LENGTH = 60

# A SHA-256 written as 64 lower-case hex characters (message keys and file hashes).
_SHA256_HEX = "^[0-9a-f]{64}$"


class IntakeAllowKind(str, enum.Enum):
    """An allow-list entry is either one address or a whole domain (AC-20)."""

    address = "address"
    domain = "domain"


class IntakeMessageOutcome(str, enum.Enum):
    """What happened to one email as a whole. Per-file results are in `IntakeFileOutcome`."""

    processed = "processed"
    unknown_sender = "unknown_sender"
    sender_not_verified = "sender_not_verified"
    rate_limited = "rate_limited"
    no_pdf = "no_pdf"
    too_large = "too_large"
    auto_reply_ignored = "auto_reply_ignored"
    error = "error"


class IntakeReplyStatus(str, enum.Enum):
    """The one reply per email (AC-13). `none` means no reply is due (unknown sender, auto-reply)."""

    none = "none"
    pending = "pending"
    sent = "sent"
    failed = "failed"


class IntakeFileOutcome(str, enum.Enum):
    """The result for one attachment (AC-10's four outcomes, plus what an admin did to a held file)."""

    loaded = "loaded"
    needs_report_type = "needs_report_type"
    held = "held"
    released = "released"
    held_deleted = "held_deleted"
    refused = "refused"
    duplicate = "duplicate"


class IntakeReadState(str, enum.Enum):
    """Where reading stopped for a file that made a draft (AC-10 outcome 2, AC-16)."""

    queued = "queued"
    waiting_for_limit = "waiting_for_limit"
    needs_person = "needs_person"


class ReportSourceChannel(str, enum.Enum):
    """How a report arrived. Only `email` rows are written today; no row means a web upload.
    `web` is here so recording the uploader later (AC-31) needs no enum migration."""

    email = "email"
    web = "web"


class IntakeAllowEntry(Base):
    """One allowed sender: a single address or a whole domain, with a team or role label (AC-20, R-11,
    R-18). Admins manage the list (AC-21, AC-32); no address is ever seeded. `value` is stored
    lower-case and is unique, so the same address or domain cannot be listed twice. An address has an
    `@`, a domain has none (CHECK). The label is copied into `report_sources` at intake time, so editing
    or removing an entry never changes past reports (AC-30)."""

    __tablename__ = "intake_allow_entries"
    __table_args__ = (
        UniqueConstraint("value", name="uq_intake_allow_entries_value"),
        CheckConstraint("value = lower(value)", name="ck_intake_allow_entries_value_lower"),
        CheckConstraint(
            "(kind = 'address') = (strpos(value, '@') > 0)", name="ck_intake_allow_entries_kind_matches_value"
        ),
        CheckConstraint("char_length(btrim(label)) > 0", name="ck_intake_allow_entries_label_not_blank"),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    kind: Mapped[IntakeAllowKind] = mapped_column(Enum(IntakeAllowKind, name="intake_allow_kind"), nullable=False)
    value: Mapped[str] = mapped_column(String(ADDRESS_MAX_LENGTH), nullable=False)
    label: Mapped[str] = mapped_column(String(LABEL_MAX_LENGTH), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IntakeMessage(Base):
    """One row per email the worker handled, whatever the outcome: the admin's Email log (AC-11, AC-12)
    and the dedupe record (AC-18).

    `message_key` is the SHA-256 hex of the normalized Message-ID (or, when there is none, of the Date
    header plus every attachment's SHA-256); the raw Message-ID is not stored. It is unique, so the same
    email delivered twice cannot make a second row. `sender_address` and `sender_label` are set together
    and only when the sender matched the allow list; a reply can only be due when they are set (AC-15).
    Rows older than EMAIL_LOG_RETENTION_DAYS are pruned by the worker with their files (cascade), except
    a message that still has a held file."""

    __tablename__ = "intake_messages"
    __table_args__ = (
        UniqueConstraint("message_key", name="uq_intake_messages_message_key"),
        CheckConstraint(f"message_key ~ '{_SHA256_HEX}'", name="ck_intake_messages_message_key_sha256"),
        CheckConstraint(
            "(sender_address IS NULL) = (sender_label IS NULL)", name="ck_intake_messages_sender_pair"
        ),
        # The address of a sender who is not on the allow list, or not verified, is never stored (AC-12, R-4).
        CheckConstraint(
            "sender_address IS NULL OR outcome NOT IN ('unknown_sender', 'sender_not_verified')",
            name="ck_intake_messages_no_address_for_unknown",
        ),
        # A reply goes only to a stored (allowed, verified) address (AC-15, R-4).
        CheckConstraint(
            "reply_status = 'none' OR sender_address IS NOT NULL", name="ck_intake_messages_reply_needs_address"
        ),
        CheckConstraint(
            "reply_sent_at IS NULL OR reply_status = 'sent'", name="ck_intake_messages_reply_sent_at"
        ),
        CheckConstraint(
            "file_count >= 0 AND files_skipped >= 0 AND reply_attempts >= 0",
            name="ck_intake_messages_counts_not_negative",
        ),
        # The per-sender hourly limit (R-10): messages from one address since a time.
        Index("ix_intake_messages_sender_received", "sender_address", "received_at"),
        # The poller's "replies still to send" query; only pending rows are in the index.
        Index(
            "ix_intake_messages_reply_pending", "handled_at", postgresql_where=text("reply_status = 'pending'")
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    message_key: Mapped[str] = mapped_column(String(64), nullable=False)
    # Mailbox arrival time (IMAP INTERNALDATE, or the file's mtime for the folder mailbox).
    # Indexed for the Email log (newest first) and for pruning.
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    handled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    sender_address: Mapped[str | None] = mapped_column(String(ADDRESS_MAX_LENGTH), nullable=True)
    sender_label: Mapped[str | None] = mapped_column(String(LABEL_MAX_LENGTH), nullable=True)
    outcome: Mapped[IntakeMessageOutcome] = mapped_column(
        Enum(IntakeMessageOutcome, name="intake_message_outcome"), nullable=False
    )
    # Fixed app text only (for example "Sender is not on the allow list."), never text from the message.
    reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # Attachments seen, of every type.
    file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    # PDFs beyond the per-message limit (AC-02); they have no intake_files row.
    files_skipped: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    reply_status: Mapped[IntakeReplyStatus] = mapped_column(
        Enum(IntakeReplyStatus, name="intake_reply_status"),
        nullable=False,
        default=IntakeReplyStatus.none,
        server_default=text("'none'"),
    )
    reply_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default=text("0"))
    reply_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # passive_deletes: pruning a message lets the database's ON DELETE CASCADE remove its files.
    files: Mapped[list["IntakeFile"]] = relationship(
        back_populates="message", cascade="all, delete-orphan", passive_deletes=True, order_by="IntakeFile.position"
    )


class IntakeFile(Base):
    """One row per attachment that was looked at, non-PDFs included, so the reply can list each one by
    position ("Attachment 2"; AC-02, AC-13). No attachment name is stored (AC-24). A refused file is never
    written to disk (R-9). A held file (AC-10 outcome 4) is kept under `<storage>/email-held/` and
    `held_path` is set only while the outcome is `held` (CHECK); release or delete clears it (AC-26).
    `report_id` points at the draft the file made and is set to NULL if that report is deleted.
    `read_state` says where reading stopped (AC-16): `waiting_for_limit` files are queued again by the
    poller once the daily limit allows, and `waiting_kind` says which job waits."""

    __tablename__ = "intake_files"
    __table_args__ = (
        # Also serves every lookup by message_id (it is the leading column), so there is no separate index.
        UniqueConstraint("message_id", "position", name="uq_intake_files_message_position"),
        CheckConstraint("position >= 1", name="ck_intake_files_position_positive"),
        CheckConstraint("size_bytes >= 0", name="ck_intake_files_size_not_negative"),
        CheckConstraint("page_count IS NULL OR page_count >= 0", name="ck_intake_files_page_count_not_negative"),
        CheckConstraint(
            f"content_sha256 IS NULL OR content_sha256 ~ '{_SHA256_HEX}'", name="ck_intake_files_content_sha256"
        ),
        CheckConstraint("held_path IS NULL OR outcome = 'held'", name="ck_intake_files_held_path_only_held"),
        CheckConstraint(
            "waiting_kind IS NULL OR read_state = 'waiting_for_limit'", name="ck_intake_files_waiting_kind"
        ),
        # The "Check: maybe not a service report" list (oldest first); only held rows are in the index.
        Index("ix_intake_files_held", "created_at", postgresql_where=text("outcome = 'held'")),
        # The poller's "files waiting for the daily limit" query; only waiting rows are in the index.
        Index(
            "ix_intake_files_waiting_for_limit",
            "created_at",
            postgresql_where=text("read_state = 'waiting_for_limit'"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("intake_messages.id", ondelete="CASCADE"), nullable=False
    )
    # 1-based order of the attachment in the email.
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    outcome: Mapped[IntakeFileOutcome] = mapped_column(
        Enum(IntakeFileOutcome, name="intake_file_outcome"), nullable=False
    )
    # One of: not_pdf, too_large, unsafe_pdf, not_service_report, unsure, no_text, already_on_file,
    # over_limit. A short code, not text from the file; the reply and the screens turn it into words.
    reason_code: Mapped[str | None] = mapped_column(String(40), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    report_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reports.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # Path inside the storage root (services/storage_paths.py), e.g. "email-held/<uuid>.pdf".
    held_path: Mapped[str | None] = mapped_column(String, nullable=True)
    read_state: Mapped[IntakeReadState | None] = mapped_column(
        Enum(IntakeReadState, name="intake_read_state"), nullable=True
    )
    # The existing type, shared with extraction_jobs.kind: never created or dropped here.
    waiting_kind: Mapped[ExtractionJobKind | None] = mapped_column(
        ENUM(ExtractionJobKind, name="extraction_job_kind", create_type=False), nullable=True
    )
    # When an admin released or deleted a held file.
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    message: Mapped[IntakeMessage] = relationship(back_populates="files")
    # One way on purpose: Report has no list of intake files. Deleting a report leaves this row and the
    # database sets report_id to NULL.
    report: Mapped["Report | None"] = relationship()


class ReportSource(Base):
    """Where one report came from (AC-27): how it arrived, the sender address as received, the label
    that matched, and the received time. Stored beside the report and never in a report field,
    `search_text`, the CSV or the PDF (AC-29, R-15). The address and label are copies, so a later
    allow-list edit or log pruning does not change them (AC-30). One row per report at most (the report
    id is the primary key); no row means a web upload. Deleting the report deletes this row."""

    __tablename__ = "report_sources"
    __table_args__ = (
        CheckConstraint(
            "channel <> 'email' OR (sender_address IS NOT NULL AND sender_label IS NOT NULL)",
            name="ck_report_sources_email_has_sender",
        ),
    )

    report_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("reports.id", ondelete="CASCADE"), primary_key=True
    )
    channel: Mapped[ReportSourceChannel] = mapped_column(
        Enum(ReportSourceChannel, name="report_source_channel"), nullable=False
    )
    sender_address: Mapped[str | None] = mapped_column(String(ADDRESS_MAX_LENGTH), nullable=True)
    sender_label: Mapped[str | None] = mapped_column(String(LABEL_MAX_LENGTH), nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # The intake row this report came from; NULL once the log is pruned. Indexed so that pruning (which
    # deletes intake_files) can set it to NULL without reading the whole table.
    intake_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("intake_files.id", ondelete="SET NULL"), nullable=True, index=True
    )

    report: Mapped["Report"] = relationship(back_populates="source")
    intake_file: Mapped[IntakeFile | None] = relationship()
