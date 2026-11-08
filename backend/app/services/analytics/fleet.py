"""The fleet analytics roll-up (GET /analytics/fleet)."""
from __future__ import annotations

import uuid

from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.services.field_values import as_choice_list

from .filters import AnalyticsFilters, _apply_filters, _apply_unit_filters
from .values import _LABOR_TRACKING_REPORT_TYPES, _as_number, _labor_hours_of


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
                    # A repair can have several categories; its hours are shared
                    # equally between them so the chart still adds up to the total.
                    categories = as_choice_list(fields.get("fault_category"))
                    for category in categories:
                        labor_by_fault_category[category] = (
                            labor_by_fault_category.get(category, 0.0) + labor_hours / len(categories)
                        )

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
            total_labor_hours=labor_by_instrument.get(instrument.id, 0.0),
        )
        for instrument in instruments
    ]
    by_model: dict[object, schemas.ReportCountByModelOut] = {}
    for instrument, row in zip(instruments, report_counts_by_instrument):
        # Units of one model record belong together; a unit with no record is grouped by its model name.
        entry = by_model.setdefault(
            instrument.model_id or row.model,
            schemas.ReportCountByModelOut(model=row.model, model_id=instrument.model_id, unit_count=0, report_count=0),
        )
        entry.unit_count += 1
        entry.report_count += row.report_count
        entry.total_labor_hours += row.total_labor_hours
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
