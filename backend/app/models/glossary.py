"""The technical glossary: how a term on a Hebrew form should come out in English."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

from .enums import _uuid_pk


class GlossaryTerm(Base):
    """One technical term. `english_term` is the wording to use. `source_term` is the term as printed on the
    Hebrew form ("כיוון לייזר"), given to the translation prompt. `wrong_term` is a wrong English rendering seen
    before ("laser direction"): the prompt is told never to write it, and a translation that still has it is
    corrected after the call (services/glossary.py). At least one of the two is set."""

    __tablename__ = "glossary_terms"

    id: Mapped[uuid.UUID] = _uuid_pk()
    source_term: Mapped[str | None] = mapped_column(String, nullable=True)
    wrong_term: Mapped[str | None] = mapped_column(String, nullable=True)
    english_term: Mapped[str] = mapped_column(String, nullable=False)
    note: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
