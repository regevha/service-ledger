"""SQLAlchemy models — a direct implementation of the spec's §5 data model.

Table shapes, column names, and nullability all mirror SL-ARCH-001 §5 exactly:
`reports.instrument_id` / `template_id` are nullable because document-first
intake (§4) resolves them after classification rather than at creation, and
`extraction_jobs.classification` is a separate JSONB column from
`field_confidences` because it gates which template the rest of the job runs
against. See the spec (published Artifact) for the full rationale behind each
of these choices — this file only encodes the decisions, it doesn't re-argue them.
"""
import enum
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Enum, ForeignKey, Index, Integer, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class InstrumentStatus(str, enum.Enum):
    """Not specified in the spec's data-model table — a reasonable MVP default,
    flagged here (rather than silently assumed) so it's easy to spot and revise."""

    active = "active"
    maintenance = "maintenance"
    retired = "retired"


class ReportStatus(str, enum.Enum):
    """Exactly the five values named in §5: draft -> classified -> extracted ->
    in_review -> finalized."""

    draft = "draft"
    classified = "classified"
    extracted = "extracted"
    in_review = "in_review"
    finalized = "finalized"


class ReportType(str, enum.Enum):
    calibration = "calibration"
    repair = "repair"
    preventive_maintenance = "preventive_maintenance"


class ExtractionJobStatus(str, enum.Enum):
    """Not enumerated explicitly in §5 ("status") — the obvious lifecycle for a
    background job, kept minimal on purpose."""

    pending = "pending"
    classifying = "classifying"
    extracting = "extracting"
    succeeded = "succeeded"
    failed = "failed"


class ExtractionJobKind(str, enum.Enum):
    """Which half of §4's pipeline this job runs. Not a spec-named column —
    the spec's job table (§5) describes "one classify-then-extract attempt"
    in prose, but the actual endpoints (§9) submit classify and extract as
    two separate calls with a manual-confirm checkpoint possibly in between
    (§4/§6), so each call gets its own job row rather than one row trying to
    span a human-in-the-loop gap. `app.worker` reads this to know which
    service function to run for a `pending` row."""

    classify = "classify"
    extract = "extract"


class Instrument(Base):
    """§5: the physical asset. `instrument_type` is fixed to "facs" for MVP but
    stored as a plain string (not a native enum) so the spec's "stays open for
    other vendors and categories later" (§2) doesn't require a migration to honor."""

    __tablename__ = "instruments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default="facs")
    model: Mapped[str] = mapped_column(String, nullable=False)
    serial_number: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[InstrumentStatus] = mapped_column(
        Enum(InstrumentStatus, name="instrument_status"), nullable=False, default=InstrumentStatus.active
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    reports: Mapped[list["Report"]] = relationship(back_populates="instrument")


class ReportTemplate(Base):
    """§5: the expected shape of a report for one (instrument_type, report_type,
    model) combination. A NULL `model` applies to every model of that
    instrument_type unless a model-specific row exists for the same
    report_type, which takes precedence (§2) — see services/templates.py for
    where that resolution actually happens."""

    __tablename__ = "report_templates"
    __table_args__ = (
        # See alembic/versions/6b5fc4e1c3ca_*.py for the full rationale
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
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default="facs")
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

    id: Mapped[uuid.UUID] = _uuid_pk()
    instrument_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("instruments.id"), nullable=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("report_templates.id"), nullable=True
    )
    status: Mapped[ReportStatus] = mapped_column(
        Enum(ReportStatus, name="report_status"), nullable=False, default=ReportStatus.draft
    )
    extracted_fields: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)

    # Real columns regardless of report type or template variant (§5): the
    # reporting layer (§7) filters/sorts on these across every report.
    technician_name: Mapped[str | None] = mapped_column(String, nullable=True)
    service_actions: Mapped[str | None] = mapped_column(String, nullable=True)
    parts_replaced: Mapped[str | None] = mapped_column(String, nullable=True)
    next_service_due: Mapped[date | None] = mapped_column(Date, nullable=True)

    report_date: Mapped[date | None] = mapped_column(Date, nullable=True)
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
    report_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("reports.id"), nullable=False)
    file_path: Mapped[str] = mapped_column(String, nullable=False)
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
    extraction_jobs: Mapped[list["ExtractionJob"]] = relationship(back_populates="attachment")


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
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    attachment: Mapped[Attachment] = relationship(back_populates="extraction_jobs")


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
