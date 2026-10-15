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

from sqlalchemy import Date, DateTime, Enum, Float, ForeignKey, Index, Integer, String, Text, func, text
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
    # Installing options or hardware, or upgrading software/firmware (BD task
    # code T107). Added after a real software-upgrade report fit none of the
    # first three types.
    installation_upgrade = "installation_upgrade"


class ExtractionJobStatus(str, enum.Enum):
    """Not enumerated explicitly in §5 ("status") — the obvious lifecycle for a
    background job, kept minimal on purpose."""

    pending = "pending"
    classifying = "classifying"
    extracting = "extracting"
    translating = "translating"
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
    # Hebrew (or other foreign-language) documents are translated to English
    # first and a person reviews the result before classify/extract run.
    translate = "translate"


class TranslationStatus(str, enum.Enum):
    """Life of one translation record. A person always reviews a translation
    (`pending_review` -> `accepted`); `discarded` means the original is used as
    it is today; `superseded` is a replaced translation kept as history;
    `not_needed` records that the document was checked and is not Hebrew."""

    pending_review = "pending_review"
    accepted = "accepted"
    discarded = "discarded"
    superseded = "superseded"
    not_needed = "not_needed"


class InstrumentType(Base):
    """A kind of instrument ("Flow cytometer", "Electron microscope"). `key` is
    the stable value stored in `instruments.instrument_type` and
    `report_templates.instrument_type`; `display_name` is what people see. The
    columns stay plain strings (not foreign keys) and are validated against this
    table by the API (services/instrument_types.py), so older rows and seed
    scripts keep working. Distinct from `Instrument.manufacturer`, which says
    who makes the instrument, not what kind it is."""

    __tablename__ = "instrument_types"

    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Instrument(Base):
    """§5: the physical asset. `instrument_type` is the `key` of an
    InstrumentType row (default "facs", shown as "Flow cytometer"), stored as a
    plain string rather than a native enum so adding a type needs no migration."""

    __tablename__ = "instruments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    instrument_type: Mapped[str] = mapped_column(String, nullable=False, default="facs")
    model: Mapped[str] = mapped_column(String, nullable=False)
    # Free text ("BD", "Beckman Coulter"); NULL when not recorded. The fleet is
    # no longer BD-only, but existing rows predate this column.
    manufacturer: Mapped[str | None] = mapped_column(String, nullable=True)
    # Free text: the company that sells and services this unit locally when that
    # is not the maker ("Rhenium", "almog diagnostic"); NULL when there is none or
    # it is not recorded. Optional, unlike the manufacturer.
    distributor: Mapped[str | None] = mapped_column(String, nullable=True)
    serial_number: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    location: Mapped[str | None] = mapped_column(String, nullable=True)
    status: Mapped[InstrumentStatus] = mapped_column(
        Enum(InstrumentStatus, name="instrument_status"), nullable=False, default=InstrumentStatus.active
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # passive_deletes=True for the same reason as ReportTemplate.reports: without
    # it the ORM would null out each Report's instrument_id as part of deleting
    # an Instrument, silently defeating routers/instruments.py's in-use check
    # under a race. Left alone, the FK (no ondelete, so RESTRICT) rejects the
    # delete at commit time, which delete_instrument turns into a clean 409.
    reports: Mapped[list["Report"]] = relationship(back_populates="instrument", passive_deletes=True)


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
        UUID(as_uuid=True), ForeignKey("instruments.id"), nullable=True
    )
    template_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("report_templates.id"), nullable=True
    )
    status: Mapped[ReportStatus] = mapped_column(
        Enum(ReportStatus, name="report_status"), nullable=False, default=ReportStatus.draft
    )
    extracted_fields: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
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


class SavedReportFilter(Base):
    """A named combination of the Reports list's six filters, shared by
    everyone (proposal-saved-filters.md). `filters` holds only the criteria
    that were set, under the same keys GET /reports already takes. Names are
    unique ignoring case and surrounding spaces (a unique index on
    lower(btrim(name)), declared here as well as in the migration so the
    test database, built from metadata, enforces it too). `created_by` stays
    NULL until sign-in exists."""

    __tablename__ = "saved_report_filters"
    __table_args__ = (Index("uq_saved_report_filters_name", text("lower(btrim(name))"), unique=True),)

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    filters: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


# Importing the search module registers the before_flush listener that keeps
# Report.search_text current (see services/report_search.py). It lives at the
# bottom because that module imports this one.
from app.services import report_search  # noqa: E402,F401
