"""Seeds the six report_templates rows described in spec §5.

Field lists are transcribed field-for-field from the spec's tables — see
CL-ARCH-001 §5 for the unit notes and the rationale behind each template's
shape (why repair stays one shared row while calibration and PM split by
model, why JSONB over a wide table, etc). This module only encodes the
already-decided shape; run it once against a fresh database via
`python -m app.seed_templates`.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import ReportTemplate, ReportType

CST_CALIBRATION_FIELDS = [
    {"name": "laser_configuration", "type": "enum[]", "unit": None, "notes": "e.g. 405nm, 488nm, 640nm"},
    {"name": "cst_beads_lot", "type": "text", "unit": None, "notes": "lot number, for traceability"},
    {"name": "baseline_cv_percent", "type": "number[detector]", "unit": "%", "notes": "per-detector, flag if > 5%"},
    {"name": "pmt_voltages", "type": "number[detector]", "unit": "V", "notes": "volts"},
    {"name": "fluidics_pressure_psi", "type": "number", "unit": "psi", "notes": None},
    {"name": "compensation_matrix_updated", "type": "boolean", "unit": None, "notes": None},
]

SPECTRAL_CALIBRATION_FIELDS = [
    {
        "name": "laser_configuration",
        "type": "enum[]",
        "unit": None,
        "notes": "e.g. 355nm, 405nm, 488nm, 561nm, 640nm",
    },
    {"name": "spectral_qc_beads_lot", "type": "text", "unit": None, "notes": "lot number, for traceability"},
    {
        "name": "reference_controls_acquired",
        "type": "boolean",
        "unit": None,
        "notes": "single-stain controls run for unmixing",
    },
    {
        "name": "unmixing_error_percent",
        "type": "number",
        "unit": "%",
        "notes": "flag if above the instrument's threshold",
    },
    {"name": "autofluorescence_extraction_verified", "type": "boolean", "unit": None, "notes": None},
    {"name": "imaging_focus_calibration_passed", "type": "boolean", "unit": None, "notes": "S8-specific imaging module"},
]

REPAIR_FIELDS = [
    {
        "name": "fault_description",
        "type": "text",
        "unit": None,
        "notes": "reported symptom (BD's Subject line + Description)",
    },
    {"name": "root_cause", "type": "text", "unit": None, "notes": "matches the form's own \"Cause\" section"},
    {
        "name": "work_performed",
        "type": "text",
        "unit": None,
        "notes": "diagnostic/repair narrative (\"Work Performed / Solution Comments\")",
    },
    {
        "name": "components_replaced",
        "type": "object[]",
        "unit": None,
        "notes": "one entry per part; mirrors the form's \"Parts Used\" table",
        "item_schema": {"part_name": "text", "part_number": "text", "qty": "number"},
    },
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": "rounded total from the form's \"Labor\" line"},
    {
        "name": "fault_category",
        "type": "enum",
        "unit": None,
        "notes": "technician-assigned, not on the source form",
        "options": ["fluidics", "optics", "electronics", "software"],
    },
    {
        "name": "retest_result",
        "type": "enum",
        "unit": None,
        "notes": "technician-assigned, not on the source form",
        "options": ["pass", "fail", "not retested"],
    },
]

PM_CORE_FIELDS = [
    {"name": "fluidics_system_flushed", "type": "boolean", "unit": None, "notes": None},
    {"name": "filters_replaced", "type": "boolean", "unit": None, "notes": None},
    {"name": "sheath_waste_tank_serviced", "type": "boolean", "unit": None, "notes": None},
    {"name": "laser_hours_logged", "type": "number[laser]", "unit": "hours", "notes": "cumulative, per laser line"},
    {"name": "firmware_version_verified", "type": "text", "unit": None, "notes": None},
    {"name": "next_pm_due", "type": "date", "unit": None, "notes": None},
]

PM_ARIA_ADDITIONS = [
    {"name": "nozzle_orifice_inspected", "type": "boolean", "unit": None, "notes": "cell-sorter hardware"},
    {"name": "drop_delay_recalibrated", "type": "boolean", "unit": None, "notes": "cell-sorter hardware"},
    {"name": "sort_precision_cv_percent", "type": "number", "unit": "%", "notes": "cell-sorter hardware"},
]

PM_S8_ADDITIONS = [
    {"name": "nozzle_orifice_inspected", "type": "boolean", "unit": None, "notes": "sort-specific, shared with the Aria III"},
    {"name": "drop_delay_recalibrated", "type": "boolean", "unit": None, "notes": "sort-specific, shared with the Aria III"},
    {"name": "optical_filter_wheel_inspected", "type": "boolean", "unit": None, "notes": "S8 imaging/spectral hardware"},
    {"name": "imaging_module_calibration_verified", "type": "boolean", "unit": None, "notes": "S8 imaging/spectral hardware"},
]

# (report_type, model) -> field list. model=None means the NULL-model
# fallback row (§2, §5): applies to every model of the instrument_type unless
# a model-specific row exists for the same report_type.
TEMPLATE_ROWS: list[tuple[ReportType, str | None, list[dict]]] = [
    (ReportType.calibration, None, CST_CALIBRATION_FIELDS),
    (ReportType.calibration, "FACSDiscover S8", SPECTRAL_CALIBRATION_FIELDS),
    (ReportType.repair, None, REPAIR_FIELDS),
    (ReportType.preventive_maintenance, "FACSAria III", PM_CORE_FIELDS + PM_ARIA_ADDITIONS),
    (ReportType.preventive_maintenance, "LSRFortessa", list(PM_CORE_FIELDS)),
    (ReportType.preventive_maintenance, "FACSDiscover S8", PM_CORE_FIELDS + PM_S8_ADDITIONS),
]


def seed(db: Session) -> list[ReportTemplate]:
    created = []
    for report_type, model, fields in TEMPLATE_ROWS:
        existing = (
            db.query(ReportTemplate)
            .filter(
                ReportTemplate.instrument_type == "facs",
                ReportTemplate.report_type == report_type,
                ReportTemplate.model == model,
            )
            .one_or_none()
        )
        if existing:
            existing.field_schema = {"fields": fields}
            created.append(existing)
            continue
        row = ReportTemplate(
            instrument_type="facs",
            report_type=report_type,
            model=model,
            field_schema={"fields": fields},
        )
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        rows = seed(session)
        print(f"Seeded/updated {len(rows)} report_templates rows:")
        for row in rows:
            print(f"  - {row.report_type.value:26s} model={row.model or '(any)'}")
