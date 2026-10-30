"""Reliability figures for one model (models plan, step 4, part B).

Built from the finalized repair reports of the model's instruments. The parts
list reuses the fleet analytics with a model filter; everything else is worked
out here. Nothing is stored. Honest limits: a repair with no report date is left
out of the gaps (and counted), fault categories exist only where the template
has the field and extraction read it (the page shows how many repairs had one),
and averages are withheld below MIN_REPAIRS repairs.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from statistics import mean

from sqlalchemy.orm import Session, joinedload

from app import models, schemas
from app.services.field_values import as_choice_list
from app.services.analytics import AnalyticsFilters, _labor_hours_of, compute_fleet_analytics

MIN_REPAIRS = 3
TOP_PARTS = 10


def compute_model_reliability(db: Session, model_id: uuid.UUID) -> schemas.ModelReliabilityOut:
    units = (
        db.query(models.Instrument).filter(models.Instrument.model_id == model_id).order_by(models.Instrument.name).all()
    )
    repairs = (
        db.query(models.Report)
        .join(models.ReportTemplate, models.Report.template_id == models.ReportTemplate.id)
        .join(models.Instrument, models.Report.instrument_id == models.Instrument.id)
        .options(joinedload(models.Report.template))
        .filter(
            models.Instrument.model_id == model_id,
            models.Report.status == models.ReportStatus.finalized,
            models.ReportTemplate.report_type == models.ReportType.repair,
        )
        .all()
    )
    enough = len(repairs) >= MIN_REPAIRS

    dates_by_unit: dict[uuid.UUID, list] = defaultdict(list)
    count_by_unit: dict[uuid.UUID, int] = defaultdict(int)
    # category -> instrument id -> number of repairs
    categories: dict[str, dict[uuid.UUID, int]] = defaultdict(lambda: defaultdict(int))
    without_date = with_category = 0
    hours: list[float] = []
    for report in repairs:
        count_by_unit[report.instrument_id] += 1
        if report.report_date is None:
            without_date += 1
        else:
            dates_by_unit[report.instrument_id].append(report.report_date)
        fields = report.extracted_fields or {}
        chosen = as_choice_list(fields.get("fault_category"))
        if chosen:
            with_category += 1
            for category in chosen:
                categories[category][report.instrument_id] += 1
        found = _labor_hours_of(fields)
        if found is not None:
            hours.append(found)

    all_gaps: list[int] = []
    unit_rows = []
    for unit in units:
        days = sorted(dates_by_unit.get(unit.id, []))
        gaps = [(b - a).days for a, b in zip(days, days[1:])]
        all_gaps.extend(gaps)
        unit_rows.append(
            schemas.ModelUnitReliabilityOut(
                instrument_id=unit.id,
                name=unit.name,
                serial_number=unit.serial_number,
                repair_count=count_by_unit.get(unit.id, 0),
                mean_days_between_repairs=mean(gaps) if gaps and enough else None,
            )
        )

    fault_rows = sorted(
        (
            schemas.ModelFaultCategoryOut(
                category=name,
                report_count=sum(per_unit.values()),
                instrument_count=len(per_unit),
                repeat=any(n >= 2 for n in per_unit.values()),
            )
            for name, per_unit in categories.items()
        ),
        key=lambda c: (-c.report_count, c.category),
    )

    fleet = compute_fleet_analytics(db, AnalyticsFilters(model_id=model_id))
    return schemas.ModelReliabilityOut(
        repair_count=len(repairs),
        min_repairs=MIN_REPAIRS,
        enough_data=enough,
        repairs_without_date=without_date,
        repairs_with_fault_category=with_category,
        mean_days_between_repairs=mean(all_gaps) if all_gaps and enough else None,
        gap_count=len(all_gaps),
        avg_labor_hours=mean(hours) if hours and enough else None,
        repairs_with_labor_hours=len(hours),
        total_labor_hours=sum(hours),
        units=unit_rows,
        fault_categories=fault_rows,
        parts=fleet.parts_replaced[:TOP_PARTS],
    )
