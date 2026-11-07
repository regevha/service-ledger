"""Pydantic shapes: config (part of app/schemas, see __init__.py)."""
from __future__ import annotations

from pydantic import BaseModel


# ---------- App config ----------


class AppConfigOut(BaseModel):
    """GET /config (§4/§12): the confidence thresholds the frontend used to
    hardcode as its own literal copies of app/config.py's settings. Those two
    numbers drive real UI behavior (review-flagging, badge coloring), so a
    backend .env change used to silently desync the UI instead of the UI
    just reading the real value from here."""

    field_confidence_threshold: float
    classification_confidence_threshold: float
    # False when running without an API key: extraction values are then
    # deterministic placeholders and their "confidence" is not a measurement,
    # so the UI labels them as placeholders instead of showing a percentage.
    live_claude: bool = False
