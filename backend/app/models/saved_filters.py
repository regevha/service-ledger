"""Saved Reports-list filters."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Index, String, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from .enums import _uuid_pk


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
