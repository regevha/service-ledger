"""Field alias groups and their names."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

from .enums import _uuid_pk


class FieldAliasGroup(Base):
    """A set of field names that mean the same thing under different wording
    ("fault_category" and "fault_type", say), kept by hand and shared by
    everyone (proposal-template-comparison.md, phase 2). It is advice for a
    person comparing templates: nothing renames or merges a field because of
    it, and extraction, the review screen and Analytics never read it. `label`
    is an optional plain-language name for the concept."""

    __tablename__ = "field_alias_groups"

    id: Mapped[uuid.UUID] = _uuid_pk()
    label: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    names: Mapped[list["FieldAliasName"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="FieldAliasName.position",
    )


class FieldAliasName(Base):
    """One name in an alias group, as the person typed it. `normalized` (case,
    spaces, underscores and hyphens removed, the same rule the comparison uses
    to match fields) is unique across every group, so a name belongs to at most
    one concept."""

    __tablename__ = "field_alias_names"

    id: Mapped[uuid.UUID] = _uuid_pk()
    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("field_alias_groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    normalized: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    group: Mapped["FieldAliasGroup"] = relationship(back_populates="names")
