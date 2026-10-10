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
from app.models import report_chronological_order

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

        # PartUsageOut.times_replaced is documented as "number of *reports*"
        # that mentioned a part, not a count of components_replaced rows —
        # total_qty is what's supposed to capture "replaced several units of
        # the same part in one visit." Tracking which (part_name,
        # part_number) keys this report has already counted keeps a report
        # with two separate rows for the same part (e.g. two O-rings entered
        # as two rows instead of one row with qty: 2) from inflating
        # times_replaced past 1 for this report, while total_qty still sums
        # every row's qty as before.
        counted_this_report: set[tuple[str, str | None]] = set()
        for entry in fields.get("components_replaced") or []:
            if not isinstance(entry, dict):
                continue
            part_name = entry.get("part_name")
            if not part_name:
                continue
            key = (part_name, entry.get("part_number"))
            bucket = parts.setdefault(key, {"times_replaced": 0, "total_qty": 0.0})
            if key not in counted_this_report:
                bucket["times_replaced"] += 1
                counted_this_report.add(key)
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


# ---------- trend helpers (shared by routers/instruments.py and the model comparison) ----------

# field_schema's three numeric-capable types: a flat "number" contributes one
# value per report; the other two a {key: value} map (one entry per
# detector/laser).
TREND_MAP_TYPES = {schemas.TemplateFieldType.number_detector, schemas.TemplateFieldType.number_laser}
TRENDABLE_TYPES = {schemas.TemplateFieldType.number, *TREND_MAP_TYPES}


def trendable_fields(reports: list[models.Report]) -> list[schemas.TrendFieldOut]:
    """The numeric fields these reports' own templates define, sorted by name."""
    fields: dict[str, schemas.TrendFieldOut] = {}
    for report in reports:
        if not report.template:
            continue
        for f in report.template.field_schema.get("fields", []):
            if f["type"] in TRENDABLE_TYPES and f["name"] not in fields:
                fields[f["name"]] = schemas.TrendFieldOut(name=f["name"], type=f["type"], unit=f.get("unit"))
    return sorted(fields.values(), key=lambda f: f.name)


def trend_points(reports: list[models.Report], field: str) -> list[schemas.TrendPointOut]:
    """One point per report that has a real number (or a dict holding at least
    one) under `field`; `reports` should already be in chronological order."""
    points: list[schemas.TrendPointOut] = []
    for report in reports:
        value = report.extracted_fields.get(field) if report.extracted_fields else None
        # bool is a subclass of int, so it is excluded explicitly (see _as_number).
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            points.append(schemas.TrendPointOut(report_id=report.id, report_date=report.report_date, value=float(value)))
        elif isinstance(value, dict):
            numeric = {k: float(v) for k, v in value.items() if isinstance(v, (int, float)) and not isinstance(v, bool)}
            if numeric:
                points.append(schemas.TrendPointOut(report_id=report.id, report_date=report.report_date, value=numeric))
    return points


# ---------- same-model comparison ----------


def _finalized_reports_by_instrument(db: Session) -> dict[uuid.UUID, list[models.Report]]:
    reports = (
        db.query(models.Report)
        .options(joinedload(models.Report.template))
        .filter(models.Report.status == models.ReportStatus.finalized, models.Report.instrument_id.isnot(None))
        .order_by(*report_chronological_order())
        .all()
    )
    by_instrument: dict[uuid.UUID, list[models.Report]] = {}
    for report in reports:
        by_instrument.setdefault(report.instrument_id, []).append(report)
    return by_instrument


def _breakdown(counts: dict[str, int]) -> schemas.PassFailBreakdownOut:
    return schemas.PassFailBreakdownOut(
        pass_count=counts["pass"],
        fail_count=counts["fail"],
        other_count=counts["other"],
        total=counts["pass"] + counts["fail"] + counts["other"],
    )


def _unit_comparison(instrument: models.Instrument, reports: list[models.Report]) -> schemas.UnitComparisonOut:
    labor_hours = 0.0
    labor_reports = 0
    parts_qty = 0.0
    results = {
        models.ReportType.repair: {"pass": 0, "fail": 0, "other": 0},
        models.ReportType.preventive_maintenance: {"pass": 0, "fail": 0, "other": 0},
    }
    for report in reports:
        fields = report.extracted_fields or {}
        for entry in fields.get("components_replaced") or []:
            if isinstance(entry, dict):
                qty = _as_number(entry.get("qty"))
                if qty is not None:
                    parts_qty += qty
        if report.template is None or report.template.report_type not in _LABOR_TRACKING_REPORT_TYPES:
            continue
        report_type = report.template.report_type
        hours = _as_number(fields.get("labor_hours"))
        if hours is not None:
            labor_hours += hours
            labor_reports += 1
        result_field = _result_field_for(report_type)
        result = fields.get(result_field) if result_field else None
        results[report_type]["pass" if result == "pass" else "fail" if result == "fail" else "other"] += 1
    dated = [r.report_date for r in reports if r.report_date is not None]
    return schemas.UnitComparisonOut(
        instrument_id=instrument.id,
        name=instrument.name,
        serial_number=instrument.serial_number,
        status=instrument.status,
        finalized_report_count=len(reports),
        last_report_date=max(dated) if dated else None,
        labor_report_count=labor_reports,
        total_labor_hours=labor_hours,
        parts_replaced_qty=parts_qty,
        repair_results=_breakdown(results[models.ReportType.repair]),
        preventive_maintenance_results=_breakdown(results[models.ReportType.preventive_maintenance]),
    )


def compute_model_comparison(db: Session) -> list[schemas.ModelComparisonOut]:
    """Every instrument model with its units side by side. A model with a
    single unit is included (nothing to compare yet, but it is not hidden);
    units with no finalized reports show zeros rather than disappearing."""
    by_instrument = _finalized_reports_by_instrument(db)
    grouped: dict[str, list[models.Instrument]] = {}
    for instrument in db.query(models.Instrument).order_by(models.Instrument.serial_number).all():
        grouped.setdefault(instrument.model, []).append(instrument)
    out = []
    for model in sorted(grouped):
        units = grouped[model]
        all_reports = [r for u in units for r in by_instrument.get(u.id, [])]
        out.append(
            schemas.ModelComparisonOut(
                model=model,
                units=[_unit_comparison(u, by_instrument.get(u.id, [])) for u in units],
                trend_fields=trendable_fields(all_reports),
            )
        )
    return out


def compute_model_trend(db: Session, model: str, field: str) -> schemas.ModelTrendOut | None:
    """One field's series for every unit of `model`; None if no instrument has
    that model."""
    units = db.query(models.Instrument).filter(models.Instrument.model == model).order_by(models.Instrument.serial_number).all()
    if not units:
        return None
    by_instrument = _finalized_reports_by_instrument(db)
    return schemas.ModelTrendOut(
        model=model,
        field=field,
        series=[
            schemas.ModelTrendSeriesOut(
                instrument_id=u.id,
                name=u.name,
                serial_number=u.serial_number,
                points=trend_points(by_instrument.get(u.id, []), field),
            )
            for u in units
        ],
    )
