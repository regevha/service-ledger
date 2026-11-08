"""Extraction jobs and translations."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

from .enums import ExtractionJobKind, ExtractionJobStatus, TranslationStatus, _uuid_pk
from .reports import Attachment


class ExtractionJob(Base):
    """§5: one classify-then-extract attempt. `classification` is kept
    separate from `field_confidences` because it gates which template the
    rest of the job even runs against (§4, §5)."""

    __tablename__ = "extraction_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    attachment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attachments.id"), nullable=False
    )
    kind: Mapped[ExtractionJobKind] = mapped_column(
        Enum(ExtractionJobKind, name="extraction_job_kind"),
        nullable=False,
    )
    status: Mapped[ExtractionJobStatus] = mapped_column(
        Enum(ExtractionJobStatus, name="extraction_job_status"),
        nullable=False,
        default=ExtractionJobStatus.pending,
    )
    # { instrument: {value, confidence}, report_type: {value, confidence} }
    classification: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # { field_name: confidence }
    field_confidences: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Set when status=failed — a human-readable reason from ClassificationError/
    # ExtractionError (see services/errors.py), not a stack trace. NULL for
    # every other status.
    error_message: Mapped[str | None] = mapped_column(String, nullable=True)
    # Options for the job, e.g. {"include_pages": [2, 3]} for a translate job
    # that should translate pages it would otherwise skip as QC printouts.
    params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # The prompt waiting for a person's Send/Cancel while status=awaiting_approval
    # (VIEW_PROMPTS; see services/prompt_gate.py). Kept after Send for reference.
    prompt_preview: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    attachment: Mapped[Attachment] = relationship(back_populates="extraction_jobs")


class Translation(Base):
    """One English translation of one attachment, awaiting or past review.
    The original attachment is never changed; this row is linked to it and
    holds both the model's text and the text a person accepted. The English is
    shown on screen only and is not downloadable."""

    __tablename__ = "translations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    attachment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("attachments.id"), nullable=False, index=True
    )
    status: Mapped[TranslationStatus] = mapped_column(
        Enum(TranslationStatus, name="translation_status"), nullable=False
    )
    source_language: Mapped[str] = mapped_column(String, nullable=False)
    # Share of letters that are Hebrew (0 to 1): measured on the text layer, or
    # estimated by the model for an image-only document.
    hebrew_share: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    accepted_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Pages left out because they are instrument QC printouts:
    # [{"page": 2, "reason": "..."}]. A person can ask for them to be included.
    ignored_pages: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    included_pages: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    # {"checked": n, "missing": ["Y1033"]}: identifiers (serials, order and part
    # numbers) listed for the document that do not appear verbatim in the text.
    identifier_check: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Things the model could not read.
    notes: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    reader: Mapped[str] = mapped_column(String, nullable=False, default="model")
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    attachment: Mapped[Attachment] = relationship(back_populates="translations")
