"""Seeds the four report_templates rows described in spec §5 (v0.12).

Field lists are transcribed field-for-field from the spec's tables — see
SL-ARCH-001 §5 for the unit notes and the rationale behind each template's
shape (why repair and, as of v0.12, preventive_maintenance both stay one
shared row while calibration still splits by model, why JSONB over a wide
table, etc). This module only encodes the already-decided shape; run it once
against a fresh database via `python -m app.seed_templates`.
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

# Checked against four real BD Care EU Work Order Service Reports — two
# LSRFortessa repairs, a FACSAria III repair, and a FACSDiscover S8 repair —
# making this the only template confirmed against a document from every
# model in scope. All four map cleanly with zero schema changes across the
# whole set; see SL-ARCH-001 §5, §12 (v0.12).
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

# v0.12: redesigned from a guessed per-model boolean checklist to this shared,
# repair-shaped template after checking a real LSRFortessa half-year PM
# report. The real form carries no discrete per-check booleans anywhere —
# it's the same free-text "Work Performed" narrative as a repair report, plus
# Parts/Labor/Travel tables, plus one section repair reports don't have:
# a "Calibrated Tools" table of external metrology equipment used during the
# visit. laser_hours_logged, firmware_version_verified, and next_pm_due were
# all dropped — none appear on the real form, and next_pm_due duplicated the
# `reports.next_service_due` real column that already exists across every
# report type (§5). The per-model split was dropped too, on the same
# evidence-over-guess basis repair's per-model split was dropped in v0.9:
# nothing on the real form is model-specific. Checked against two real
# documents so far — an LSRFortessa visit and a FACSDiscover S8 visit, the
# latter's own imaging/optical checks sitting in the same free-text
# narrative rather than as discrete fields. Only a FACSAria III PM report
# remains unchecked — see §12.
PM_FIELDS = [
    {
        "name": "service_description",
        "type": "text",
        "unit": None,
        "notes": "BD's Subject + Description lines — often just \"Preventive Maintenance\" verbatim",
    },
    {
        "name": "work_performed",
        "type": "text",
        "unit": None,
        "notes": "the maintenance narrative (cleaning, PM-kit exchange, checks performed, CS&T baseline, final inspection outcome)",
    },
    {
        "name": "components_replaced",
        "type": "object[]",
        "unit": None,
        "notes": "one entry per part; mirrors the form's \"Parts Used\" table (PM kits, not fault repairs)",
        "item_schema": {"part_name": "text", "part_number": "text", "qty": "number"},
    },
    {
        "name": "calibrated_tools",
        "type": "object[]",
        "unit": None,
        "notes": "external test equipment used, from the form's \"Calibrated Tools\" table — not present on repair reports",
        "item_schema": {
            "tool_id": "text",
            "tool_name": "text",
            "last_calibration_date": "date",
            "next_calibration_date": "date",
        },
    },
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": "rounded total from the form's \"Labor\" line"},
    {
        "name": "verification_result",
        "type": "enum",
        "unit": None,
        "notes": "technician-assigned, not on the source form — mirrors repair's retest_result",
        "options": ["pass", "fail", "not verified"],
    },
]

# (report_type, model) -> field list. model=None means the NULL-model
# fallback row (§2, §5): applies to every model of the instrument_type unless
# a model-specific row exists for the same report_type. As of v0.12, only
# calibration still has a model-specific row (FACSDiscover S8's spectral
# variant) — repair (v0.9) and preventive_maintenance (v0.12) both collapsed
# to a single shared row once checked against real documents.
TEMPLATE_ROWS: list[tuple[ReportType, str | None, list[dict]]] = [
    (ReportType.calibration, None, CST_CALIBRATION_FIELDS),
    (ReportType.calibration, "FACSDiscover S8", SPECTRAL_CALIBRATION_FIELDS),
    (ReportType.repair, None, REPAIR_FIELDS),
    (ReportType.preventive_maintenance, None, PM_FIELDS),
]


def seed(db: Session) -> list[ReportTemplate]:
    """Upserts every row in TEMPLATE_ROWS, then removes any report_templates
    row for a report_type covered here that isn't in the current desired set
    — e.g. the three old per-model preventive_maintenance rows a v0.12
    redesign left behind. A Report already pointing at a removed row keeps
    its template_id (the FK isn't touched), it just won't resolve for new
    reports; this is a dev/eval-scale convenience (§1), not a migration
    tool."""
    desired = {(rt, model) for rt, model, _ in TEMPLATE_ROWS}
    covered_report_types = {rt for rt, _, _ in TEMPLATE_ROWS}

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
    db.flush()

    stale = [
        row
        for row in db.query(ReportTemplate)
        .filter(ReportTemplate.instrument_type == "facs", ReportTemplate.report_type.in_(covered_report_types))
        .all()
        if (row.report_type, row.model) not in desired
    ]
    for row in stale:
        db.delete(row)

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
