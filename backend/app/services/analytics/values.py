"""Small number helpers shared by the fleet roll-up and the model comparison."""
from __future__ import annotations

from app import models

# The report types that carry labor_hours/components_replaced
# fields (seed_templates.py). Installation/upgrade reports are left out
# rather than appearing as an always-zero row.
_LABOR_TRACKING_REPORT_TYPES = (models.ReportType.repair, models.ReportType.preventive_maintenance)


def _as_number(value: object) -> float | None:
    # bool is a subclass of int in Python — isinstance(True, int) is True —
    # so it's excluded explicitly rather than let a stray boolean field
    # silently count as 1.0/0.0 hours or quantity.
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def _labor_hours_of(fields: dict) -> float | None:
    """The hours recorded on a report. The standard field is `labor_hours`; a template a
    lab edited may call it something else ("Labor time", "labour_hours"), so when that
    one is absent the first field with "labor"/"labour" in its name is used. A number
    that was saved as text ("3.5") still counts; anything else is "not recorded"."""

    def lenient(value: object) -> float | None:
        number = _as_number(value)
        if number is not None:
            return number
        if isinstance(value, str):
            try:
                return float(value.strip().replace(",", "."))
            except ValueError:
                return None
        return None

    if "labor_hours" in fields:
        return lenient(fields["labor_hours"])
    for name, value in fields.items():
        lowered = str(name).lower()
        if "labor" in lowered or "labour" in lowered:
            found = lenient(value)
            if found is not None:
                return found
    return None
