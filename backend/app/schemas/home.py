"""The numbers on the Home screen (GET /home/summary)."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


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


class HomeSummaryOut(BaseModel):
    waiting: HomeWaitingOut
    finalized: HomeFinalizedOut
    read_without_edits: HomeReadAccuracyOut
