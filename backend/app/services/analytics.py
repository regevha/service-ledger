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
from dataclasses import dataclass
from datetime import date

from sqlalchemy import func, select
from sqlalchemy.orm import Query, Session, joinedload

from app import models, schemas
from app.services.places import subtree_ids
from app.services.report_filters import apply_report_filters
from app.models import report_chronological_order

# The report types that carry labor_hours/components_replaced/pass-fail
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


def _result_field_for(report_type: models.ReportType) -> str | None:
    if report_type is models.ReportType.repair:
        return "retest_result"
    if report_type is models.ReportType.preventive_maintenance:
        return "verification_result"
    return None


@dataclass(frozen=True)
class AnalyticsFilters:
    """Which finalized reports the analytics are computed from. Every field is
    optional and they combine (all must hold). They mean the same as on the
    Reports list: `report_type` is the report's template type, and the dates
    are the report date, so a report with no date drops out as soon as a date
    bound is set. `instrument_id` also narrows which instruments are listed
    (fleet roll-up rows, comparison units), not only whose reports count; so
    does `manufacturer` (matched ignoring case and surrounding spaces), which
    selects the whole group of instruments from that maker."""

    instrument_id: uuid.UUID | None = None
    # The instruments of one model record (instrument_models.id); narrows the
    # listed instruments and whose reports count, like `manufacturer`.
    model_id: uuid.UUID | None = None
    # A place (institution, faculty or room) and everything inside it: only the
    # instruments there, and their reports. Same meaning as on the Reports list.
    place_id: uuid.UUID | None = None
    manufacturer: str | None = None
    report_type: models.ReportType | None = None
    date_from: date | None = None
    date_to: date | None = None
    # Same meaning as on the Reports list. `status` None means finalized only (what
    # the analytics always used); "all" means every status; otherwise that one status.
    status: str | None = None
    technician: str | None = None
    q: str | None = None


def _apply_unit_filters(query: Query, filters: AnalyticsFilters) -> Query:
    """The filters that choose which instruments are listed (query on Instrument)."""
    if filters.instrument_id:
        query = query.filter(models.Instrument.id == filters.instrument_id)
    if filters.model_id:
        query = query.filter(models.Instrument.model_id == filters.model_id)
    if filters.place_id:
        place = query.session.get(models.Place, filters.place_id)
        ids = subtree_ids(query.session, place) if place is not None else []
        query = query.filter(models.Instrument.place_id.in_(ids))
    if filters.manufacturer:
        query = query.filter(_same_manufacturer(filters.manufacturer))
    return query


def _same_manufacturer(name: str):
    return func.lower(func.trim(models.Instrument.manufacturer)) == name.strip().lower()


def _apply_filters(query: Query, filters: AnalyticsFilters) -> Query:
    """The Reports-list filters (shared code, services/report_filters.py) plus the analytics-only
    manufacturer. `status` None means finalized only, which is what the analytics always used;
    "all" means every status."""
    if filters.manufacturer:
        query = query.filter(
            models.Report.instrument_id.in_(select(models.Instrument.id).where(_same_manufacturer(filters.manufacturer)))
        )
    if filters.status is None:
        status = models.ReportStatus.finalized
    elif filters.status == "all":
        status = None
    else:
        status = models.ReportStatus(filters.status)
    return apply_report_filters(
        query,
        instrument_id=filters.instrument_id,
        place_id=filters.place_id,
        model_id=filters.model_id,
        report_type=filters.report_type,
        date_from=filters.date_from,
        date_to=filters.date_to,
        status=status,
        technician=filters.technician,
        q=filters.q,
    )


def compute_fleet_analytics(db: Session, filters: AnalyticsFilters | None = None) -> schemas.FleetAnalyticsOut:
    filters = filters or AnalyticsFilters()
    reports = (
        _apply_filters(
            db.query(models.Report)
            .options(joinedload(models.Report.instrument), joinedload(models.Report.template)),
            filters,
        ).all()
    )

    parts: dict[tuple[str, str | None], dict[str, float]] = {}
    labor_by_instrument: dict[uuid.UUID, float] = {}
    reports_by_instrument: dict[uuid.UUID, int] = {}
    # Every report that matched the filters (finalized unless the status filter says otherwise),
    # whatever its type, per instrument.
    report_count_by_instrument: dict[uuid.UUID, int] = {}
    # Finalized repair/PM reports that added nothing to the hours: no hours recorded, or no instrument.
    reports_without_hours = 0
    labor_by_fault_category: dict[str, float] = {}
    pass_fail: dict[str, dict[str, int]] = {rt.value: {"pass": 0, "fail": 0, "other": 0} for rt in _LABOR_TRACKING_REPORT_TYPES}

    for report in reports:
        if report.instrument_id is not None:
            report_count_by_instrument[report.instrument_id] = report_count_by_instrument.get(report.instrument_id, 0) + 1
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
            labor_hours = _labor_hours_of(fields)
            if labor_hours is None or report.instrument_id is None:
                reports_without_hours += 1
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

    instrument_query = db.query(models.Instrument).order_by(models.Instrument.name)
    instruments = _apply_unit_filters(instrument_query, filters).all()
    labor_hours_by_instrument = [
        schemas.InstrumentRollupOut(
            instrument_id=instrument.id,
            name=instrument.name,
            model=instrument.model,
            institution=instrument.institution,
            serial_number=instrument.serial_number,
            report_count=reports_by_instrument.get(instrument.id, 0),
            total_labor_hours=labor_by_instrument.get(instrument.id, 0.0),
        )
        for instrument in instruments
    ]

    report_counts_by_instrument = [
        schemas.ReportCountByInstrumentOut(
            instrument_id=instrument.id,
            name=instrument.name,
            model=instrument.model,
            institution=instrument.institution,
            serial_number=instrument.serial_number,
            report_count=report_count_by_instrument.get(instrument.id, 0),
        )
        for instrument in instruments
    ]
    by_model: dict[str, schemas.ReportCountByModelOut] = {}
    for row in report_counts_by_instrument:
        entry = by_model.setdefault(row.model, schemas.ReportCountByModelOut(model=row.model, unit_count=0, report_count=0))
        entry.unit_count += 1
        entry.report_count += row.report_count
    report_counts_by_model = sorted(by_model.values(), key=lambda m: (-m.report_count, m.model))

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

    place_rollups = _place_rollups(db, instruments, report_count_by_instrument, labor_by_instrument)

    return schemas.FleetAnalyticsOut(
        finalized_report_count=len(reports),
        parts_replaced=parts_replaced,
        total_labor_hours=sum(labor_by_instrument.values()),
        labor_hours_by_instrument=labor_hours_by_instrument,
        reports_without_labor_hours=reports_without_hours,
        report_counts_by_instrument=report_counts_by_instrument,
        report_counts_by_model=report_counts_by_model,
        place_rollups=place_rollups,
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


def _place_rollups(
    db: Session,
    instruments: list[models.Instrument],
    report_counts: dict[uuid.UUID, int],
    labor: dict[uuid.UUID, float],
) -> list[schemas.PlaceRollupOut]:
    """Instruments, reports and work hours per place, at every level an
    instrument sits under: its institution, its faculty (when its room is in
    one) and its room. An instrument counts at each level above its own place;
    one with no place counts nowhere. Only places with an instrument are listed."""
    places = {p.id: p for p in db.query(models.Place).all()}
    rows: dict[uuid.UUID, schemas.PlaceRollupOut] = {}
    for instrument in instruments:
        node = places.get(instrument.place_id) if instrument.place_id else None
        while node is not None:
            institution = node if node.kind == "institution" else places[node.parent_id]
            if node.kind == "room" and institution.kind != "institution":
                institution = places[institution.parent_id]
            row = rows.get(node.id)
            if row is None:
                row = rows[node.id] = schemas.PlaceRollupOut(
                    place_id=node.id,
                    kind=node.kind,
                    name=node.name,
                    institution_name=institution.name,
                    instrument_count=0,
                    report_count=0,
                    total_labor_hours=0.0,
                )
            row.instrument_count += 1
            row.report_count += report_counts.get(instrument.id, 0)
            row.total_labor_hours += labor.get(instrument.id, 0.0)
            node = places.get(node.parent_id) if node.parent_id else None
    return sorted(rows.values(), key=lambda r: (r.institution_name.lower(), r.kind != "institution", r.name.lower()))


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


def _finalized_reports_by_instrument(
    db: Session, filters: AnalyticsFilters | None = None
) -> dict[uuid.UUID, list[models.Report]]:
    reports = (
        _apply_filters(
            db.query(models.Report)
            .options(joinedload(models.Report.template))
            .filter(models.Report.instrument_id.isnot(None)),
            filters or AnalyticsFilters(),
        )
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


def compute_model_comparison(db: Session, filters: AnalyticsFilters | None = None) -> list[schemas.ModelComparisonOut]:
    """Every instrument model with its units side by side. A model with a
    single unit is included (nothing to compare yet, but it is not hidden);
    units with no matching finalized reports show zeros rather than
    disappearing. With an instrument filter only that unit is listed."""
    filters = filters or AnalyticsFilters()
    by_instrument = _finalized_reports_by_instrument(db, filters)
    grouped: dict[str, list[models.Instrument]] = {}
    unit_query = db.query(models.Instrument).order_by(models.Instrument.serial_number)
    for instrument in _apply_unit_filters(unit_query, filters).all():
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


def compute_model_trend(
    db: Session, model: str, field: str, filters: AnalyticsFilters | None = None
) -> schemas.ModelTrendOut | None:
    """One field's series for every unit of `model`; None if no instrument has
    that model. With an instrument filter only that unit's series is returned
    (None when the filtered instrument is not of this model)."""
    filters = filters or AnalyticsFilters()
    unit_query = db.query(models.Instrument).filter(models.Instrument.model == model).order_by(models.Instrument.serial_number)
    units = _apply_unit_filters(unit_query, filters).all()
    if not units:
        return None
    by_instrument = _finalized_reports_by_instrument(db, filters)
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
