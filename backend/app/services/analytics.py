"""Read-side aggregation for the fleet analytics dashboard (GET /analytics/fleet).

A pure function of already-finalized report data — no new columns, no new
tables. Everything here reads components_replaced / labor_hours /
fault_category / retest_result / verification_result straight out of
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
from __future__ import annotations

import uuid

from sqlalchemy.orm import Session, joinedload

from app import models, schemas

# Both report types that carry labor_hours/components_replaced/pass-fail
# fields at all (seed_templates.py) — calibration's template has neither, so
# it never contributes to any of this and is deliberately left out rather
# than appearing as an always-zero row.
_LABOR_TRACKING_REPORT_TYPES = (models.ReportType.repair, models.ReportType.preventive_maintenance)


def _as_number(value: object) -> float | None:
    # bool is a subclass of int in Python — isinstance(True, int) is True —
    # so it's excluded explicitly rather than let a stray boolean field
    # silently count as 1.0/0.0 hours or quantity.
    if isinstance(value, bool):
        return None
    return float(value) if isinstance(value, (int, float)) else None


def _result_field_for(report_type: models.ReportType) -> str | None:
    if report_type is models.ReportType.repair:
        return "retest_result"
    if report_type is models.ReportType.preventive_maintenance:
        return "verification_result"
    return None


def compute_fleet_analytics(db: Session) -> schemas.FleetAnalyticsOut:
    reports = (
        db.query(models.Report)
        .options(joinedload(models.Report.instrument), joinedload(models.Report.template))
        .filter(models.Report.status == models.ReportStatus.finalized)
        .all()
    )

    parts: dict[tuple[str, str | None], dict[str, float]] = {}
    labor_by_instrument: dict[uuid.UUID, float] = {}
    reports_by_instrument: dict[uuid.UUID, int] = {}
    labor_by_fault_category: dict[str, float] = {}
    pass_fail: dict[str, dict[str, int]] = {rt.value: {"pass": 0, "fail": 0, "other": 0} for rt in _LABOR_TRACKING_REPORT_TYPES}

    for report in reports:
        if report.template is None:
            # Shouldn't happen for a finalized report (confirm_template is a
            # prerequisite of extraction, which is a prerequisite of
            # finalize) — skipped rather than raising, since an analytics
            # dashboard shouldn't 500 over one inconsistent row.
            continue
        report_type = report.template.report_type
        fields = report.extracted_fields or {}

        for entry in fields.get("components_replaced") or []:
            if not isinstance(entry, dict):
                continue
            part_name = entry.get("part_name")
            if not part_name:
                continue
            bucket = parts.setdefault((part_name, entry.get("part_number")), {"times_replaced": 0, "total_qty": 0.0})
            bucket["times_replaced"] += 1
            qty = _as_number(entry.get("qty"))
            if qty is not None:
                bucket["total_qty"] += qty

        if report_type in _LABOR_TRACKING_REPORT_TYPES:
            labor_hours = _as_number(fields.get("labor_hours"))
            if labor_hours is not None:
                if report.instrument_id is not None:
                    labor_by_instrument[report.instrument_id] = labor_by_instrument.get(report.instrument_id, 0.0) + labor_hours
                    reports_by_instrument[report.instrument_id] = reports_by_instrument.get(report.instrument_id, 0) + 1
                if report_type is models.ReportType.repair:
                    fault_category = fields.get("fault_category")
                    if isinstance(fault_category, str) and fault_category:
                        labor_by_fault_category[fault_category] = (
                            labor_by_fault_category.get(fault_category, 0.0) + labor_hours
                        )

            result_field = _result_field_for(report_type)
            result = fields.get(result_field) if result_field else None
            bucket_key = "pass" if result == "pass" else "fail" if result == "fail" else "other"
            pass_fail[report_type.value][bucket_key] += 1

    instruments = db.query(models.Instrument).order_by(models.Instrument.name).all()
    labor_hours_by_instrument = [
        schemas.InstrumentRollupOut(
            instrument_id=instrument.id,
            name=instrument.name,
            model=instrument.model,
            serial_number=instrument.serial_number,
            report_count=reports_by_instrument.get(instrument.id, 0),
            total_labor_hours=labor_by_instrument.get(instrument.id, 0.0),
        )
        for instrument in instruments
    ]

    parts_replaced = sorted(
        (
            schemas.PartUsageOut(
                part_name=part_name,
                part_number=part_number,
                times_replaced=int(bucket["times_replaced"]),
                total_qty=bucket["total_qty"],
            )
            for (part_name, part_number), bucket in parts.items()
        ),
        key=lambda p: p.total_qty,
        reverse=True,
    )

    return schemas.FleetAnalyticsOut(
        parts_replaced=parts_replaced,
        total_labor_hours=sum(labor_by_instrument.values()),
        labor_hours_by_instrument=labor_hours_by_instrument,
        labor_hours_by_fault_category=labor_by_fault_category,
        pass_fail_by_report_type={
            report_type: schemas.PassFailBreakdownOut(
                pass_count=counts["pass"],
                fail_count=counts["fail"],
                other_count=counts["other"],
                total=counts["pass"] + counts["fail"] + counts["other"],
            )
            for report_type, counts in pass_fail.items()
        },
    )
