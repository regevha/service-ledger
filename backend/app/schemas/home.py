"""The numbers on the Home screen (GET /home/summary)."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.models import ReportType


class HomeWaitingOut(BaseModel):
    """Reports that are read but not finalized, and how long the oldest has been waiting."""

    count: int
    oldest_created_at: datetime | None


class HomeFinalizedOut(BaseModel):
    """Reports finalized (by the day of finalizing, not the visit date) this month and in the month before."""

    this_month: int
    last_month: int


class HomeReadAccuracyOut(BaseModel):
    """Over reports finalized in the last `days` days that were read after this was tracked: how many of the
    fields the reading filled in were kept exactly as read."""

    days: int
    reports: int
    fields: int
    unchanged: int


class HomeEmailDraftOut(BaseModel):
    id: UUID
    received_at: datetime
    report_type: ReportType | None
    reason: Literal["needs_report_type", "needs_reading"]


class HomeEmailDraftsOut(BaseModel):
    count: int = 0
    items: list[HomeEmailDraftOut] = Field(default_factory=list)


class HomeSummaryOut(BaseModel):
    waiting: HomeWaitingOut
    finalized: HomeFinalizedOut
    read_without_edits: HomeReadAccuracyOut
    email_drafts: HomeEmailDraftsOut = Field(default_factory=HomeEmailDraftsOut)
