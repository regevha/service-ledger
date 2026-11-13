"""Report templates, reports and attachments."""
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.services.storage_paths import to_absolute, to_stored

from .enums import (
    DEFAULT_INSTRUMENT_TYPE_KEY,
    ReportStatus,
    ReportType,
    TranslationStatus,
    _uuid_pk,
)
from .instruments import Instrument

if TYPE_CHECKING:
    from .jobs import ExtractionJob, Translation


class ReportTemplate(Base):
    """§5: the expected shape of a report for one (instrument_type, report_type,
    model) combination. A NULL `model` applies to every model of that
    instrument_type unless a model-specific row exists for the same
    report_type, which takes precedence (§2) — see services/templates.py for
    where that resolution actually happens."""

    __tablename__ = "report_templates"
    __table_args__ = (
        # See alembic/versions/0001_baseline.py for the full rationale
        # (COALESCE(model, '') instead of a plain unique constraint, so two
        # NULL-model "any model" rows for the same (instrument_type,
        # report_type) collide too) — declared here as well, not just in
        # that migration, so `Base.metadata.create_all` (what
        # tests/conftest.py builds the test database from) actually
        # enforces it too, rather than only real deployments that ran the
        # migration.
        Index(
            "uq_report_templates_type_model",
            "instrument_type",
            "report_type",
            text("COALESCE(model, '')"),
            unique=True,
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default=DEFAULT_INSTRUMENT_TYPE_KEY)
    report_type: Mapped[ReportType] = mapped_column(Enum(ReportType, name="report_type"), nullable=False)
    model: Mapped[str | None] = mapped_column(String, nullable=True)
    field_schema: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # passive_deletes=True: without it, SQLAlchemy's default ORM-side delete
    # handling proactively SELECTs this collection and nulls each Report's
    # template_id as part of deleting a ReportTemplate, instead of leaving
    # the FK constraint (reports.template_id -> report_templates.id, no
    # ondelete set — see Report.template_id below — defaults to RESTRICT) to
    # do anything. That silently defeats routers/report_templates.py's own
    # in-use guard under a race: if a report is attached to this template
    # (PATCH /reports/{id}/template) between that guard's count-check and
    # this delete's commit, the ORM's automatic nulling let the delete
    # succeed anyway — 204, template gone, the newly-attached report's
    # template_id silently nulled out from under it. passive_deletes=True
    # leaves Report rows alone and lets the DB's own RESTRICT constraint
    # reject the delete atomically at commit time instead, which
    # delete_report_template now also catches and turns into a clean 409.
    reports: Mapped[list["Report"]] = relationship(back_populates="template", passive_deletes=True)


class Report(Base):
    """§5: one event. `instrument_id` and `template_id` start NULL under
    document-first intake (§4) and are resolved after classification rather
    than required at creation."""

    __tablename__ = "reports"
    __table_args__ = (
        # Free-text search covers finalized reports only, so the full-text index
        # does too. The expression must stay identical to
        # services/report_search.TSVECTOR_SQL (and the migration's), or the
        # search query silently stops using it.
        Index(
            "ix_reports_search_tsv",
            text("to_tsvector('simple', coalesce(search_text, ''))"),
            postgresql_using="gin",
            postgresql_where=text("status = 'finalized'"),
        ),
    )

    id: Mapped[uuid.UUID] = _uuid_pk()
    instrument_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("instruments.id"), nullable=True, index=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("report_templates.id"), nullable=True, index=True
    )
    status: Mapped[ReportStatus] = mapped_column(
        Enum(ReportStatus, name="report_status"), nullable=False, default=ReportStatus.draft, index=True
    )
    extracted_fields: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # What the reading first produced, copied once when it finishes and never edited afterwards, so the
    # Home screen can tell how many fields needed no correction. NULL for a report read before this existed.
    original_fields: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # For a scan or photo: {"attachment_id": str, "boxes": {field: {page, x, y, w, h}}}, where the model said it
    # read each value (approximate). NULL when the document had a text layer, or was read before this existed.
    field_boxes: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # The searchable text of this report (text fields, table text cells, the
    # instrument's model and serial), kept current by
    # services/report_search.py; never returned by the API.
    search_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Real columns regardless of report type or template variant (§5): the
    # reporting layer (§7) filters/sorts on these across every report.
    technician_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # Who issued the form (a distributor such as Rhenium) when the model read
    # one off the document; not the instrument's maker. Free text.
    issuer: Mapped[str | None] = mapped_column(String, nullable=True)
    # When a document fits two report types (an upgrade plus a preventive
    # maintenance visit) the primary type is the report's template and this
    # note names the other one. Free text.
    report_type_note: Mapped[str | None] = mapped_column(String, nullable=True)
    service_actions: Mapped[str | None] = mapped_column(String, nullable=True)
    parts_replaced: Mapped[str | None] = mapped_column(String, nullable=True)
    next_service_due: Mapped[date | None] = mapped_column(Date, nullable=True)

    report_date: Mapped[date | None] = mapped_column(Date, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    instrument: Mapped[Instrument | None] = relationship(back_populates="reports")
    template: Mapped[ReportTemplate | None] = relationship(back_populates="reports")
    attachments: Mapped[list["Attachment"]] = relationship(back_populates="report", cascade="all, delete-orphan")


class Attachment(Base):
    """§5: pointer to the scanned original in object storage (local disk for
    MVP — §8)."""

    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    report_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("reports.id"), nullable=False, index=True)
    # The path inside the storage root (services/storage_paths.py), so the database survives a move of
    # the storage. Everything else reads and writes `file_path` below, which is the full path.
    stored_path: Mapped[str] = mapped_column("file_path", String, nullable=False)
    # What the uploader's file was called: plain text from the client, cleaned
    # (services/attachment_names.py), used for the download name and nothing
    # else. The file on disk is named by a UUID, never by this. NULL for rows
    # that predate the column and were not backfilled.
    original_filename: Mapped[str | None] = mapped_column(String, nullable=True)
    file_type: Mapped[str] = mapped_column(String, nullable=False)
    page_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # SHA-256 of the uploaded bytes: the same scan uploaded twice is the same
    # visit recorded twice. NULL for attachments that predate this column.
    content_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # The work-order number Claude read off the document at classify time, in
    # the normalized form services/duplicates.py compares ("04587090" for
    # "WO-04587090"): the same visit scanned twice as two different files has
    # different bytes but the same work order. NULL until classified.
    work_order_number: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    report: Mapped[Report] = relationship(back_populates="attachments")

    @property
    def file_path(self) -> str:
        """The full path of the scan on disk: the stored path joined to the storage root."""
        return to_absolute(self.stored_path)

    @file_path.setter
    def file_path(self, value: str) -> None:
        self.stored_path = to_stored(value)

    # Deleting an attachment (which deleting its report does) takes its jobs
    # with it: extraction_jobs.attachment_id is NOT NULL and has no ondelete.
    extraction_jobs: Mapped[list["ExtractionJob"]] = relationship(
        back_populates="attachment", cascade="all, delete-orphan"
    )
    translations: Mapped[list["Translation"]] = relationship(
        back_populates="attachment", cascade="all, delete-orphan", order_by="Translation.created_at"
    )

    @property
    def translation_status(self) -> str | None:
        """Status of the current (newest, not superseded) translation, or None
        when the document has never been through the translate step."""
        current = [t for t in self.translations if t.status != TranslationStatus.superseded]
        return current[-1].status.value if current else None


def report_chronological_order() -> tuple:
    """ORDER BY terms for "reports in event order" — the trend chart's x-axis
    (routers/instruments.py) and the CSV export (routers/reports.py).

    report_date is nullable and nothing in the intake/review UI sets it today
    (only seed scripts and direct API calls do), so ordering by report_date
    alone left every in-app report's position up to whatever order Postgres
    happened to return NULLs in. Falling back to the report's creation date
    keeps undated reports in a stable, roughly chronological place among
    dated ones; created_at breaks ties."""
    return (func.coalesce(Report.report_date, func.date(Report.created_at)), Report.created_at)
