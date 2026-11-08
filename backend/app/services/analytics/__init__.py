"""Read-side aggregation for the fleet analytics dashboard (GET /analytics/fleet).

A pure function of already-finalized report data — no new columns, no new
tables. Everything here reads components_replaced / labor_hours /
fault_category straight out of
Report.extracted_fields, the same loosely-typed JSONB
routers/instruments.py's instrument_trend endpoint already reads a single
field out of for one instrument. Aggregation runs in Python rather than
JSONB-specific SQL for the same reason instrument_trend does: this is
single-user/dev-eval scale (SL-ARCH-001 §1), and a plain Python pass over an
already-loaded report list is far more readable and testable than a JSONB
aggregate query, for a dataset that will never be more than a few hundred
rows.

Only finalized reports contribute (matches instrument_trend's own status
filter) — draft/in-review data isn't authoritative yet, and a report can
still be edited out from under an in-flight aggregate otherwise.
"""

# Pure split of the former services/analytics.py: every name that is imported
# from outside (or was importable before) is re-exported here, so
# `from app.services.analytics import ...` keeps working unchanged.
from .comparison import (  # noqa: F401
    _finalized_reports_by_instrument,
    _unit_comparison,
    compute_model_comparison,
    compute_model_trend,
)
from .filters import (  # noqa: F401
    AnalyticsFilters,
    _apply_filters,
    _apply_unit_filters,
    _same_manufacturer,
)
from .fleet import _place_rollups, compute_fleet_analytics  # noqa: F401
from .trends import TREND_MAP_TYPES, TRENDABLE_TYPES, trend_points, trendable_fields
from .values import (  # noqa: F401
    _LABOR_TRACKING_REPORT_TYPES,
    _as_number,
    _labor_hours_of,
)

__all__ = [
    "TRENDABLE_TYPES",
    "TREND_MAP_TYPES",
    "AnalyticsFilters",
    "compute_fleet_analytics",
    "compute_model_comparison",
    "compute_model_trend",
    "trend_points",
    "trendable_fields",
]
