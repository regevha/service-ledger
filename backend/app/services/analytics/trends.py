"""Trend helpers (shared by routers/instruments.py and the model comparison)."""
from __future__ import annotations

from app import models, schemas

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
