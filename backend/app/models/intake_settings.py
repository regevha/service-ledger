"""Settings shared by report intake and the admin screen."""
from sqlalchemy import Boolean, CheckConstraint, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ReportIntakeSettings(Base):
    __tablename__ = "report_intake_settings"
    __table_args__ = (CheckConstraint("id = 1", name="ck_report_intake_settings_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    show_translation_review: Mapped[bool] = mapped_column(Boolean, nullable=False)
