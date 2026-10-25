"""Seeds the report_templates rows described in spec §5 (v0.12, plus
installation_upgrade) and three model-specific rows for the Cytek Aurora and
CytoFLEX S.

Field lists are transcribed field-for-field from the spec's tables — see
SL-ARCH-001 §5 for the unit notes and the rationale behind each template's
shape (why repair and, as of v0.12, preventive_maintenance both stay one
shared row, why JSONB over a wide
table, etc). This module only encodes the already-decided shape; run it once
against a fresh database via `python -m app.seed_templates`.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Report, ReportTemplate, ReportType

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
        # A list of {name, type} columns, not a {name: type} dict — see
        # ItemSchemaColumn's docstring (schemas.py) for why: this is exactly
        # the column order the object-array table renders, and a dict's key
        # order doesn't survive Postgres's JSONB storage.
        "item_schema": [
            {"name": "part_name", "type": "text"},
            {"name": "part_number", "type": "text"},
            {"name": "qty", "type": "number"},
        ],
    },
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": "rounded total from the form's \"Labor\" line"},
    {
        "name": "fault_category",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form",
        "options": ["fluidics", "optics", "electronics", "software"],
    },
    {
        "name": "retest_result",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form",
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
        "item_schema": [
            {"name": "part_name", "type": "text"},
            {"name": "part_number", "type": "text"},
            {"name": "qty", "type": "number"},
        ],
    },
    {
        "name": "calibrated_tools",
        "type": "object[]",
        "unit": None,
        "notes": "external test equipment used, from the form's \"Calibrated Tools\" table — not present on repair reports",
        "item_schema": [
            {"name": "tool_id", "type": "text"},
            {"name": "tool_name", "type": "text"},
            {"name": "last_calibration_date", "type": "date"},
            {"name": "next_calibration_date", "type": "date"},
        ],
    },
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": "rounded total from the form's \"Labor\" line"},
    {
        "name": "verification_result",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form — mirrors repair's retest_result",
        "options": ["pass", "fail", "not verified"],
    },
]

# Installation / upgrade visits (BD task code T107, "Install: Options,
# Upgrades, S/W"). Shaped from one real document so far — an S8 software
# upgrade from 6.2 to 6.3 — which, like the PM and repair forms, carries a
# Subject + Description, a free-text "Work Performed" narrative, a Parts Used
# table (empty for a software-only upgrade) and a Labor line, and no discrete
# checklist fields. Hardware option installs are still unchecked against a
# real form; if one needs a field this lacks, add it here. One shared row for
# every model, on the same evidence-over-guess basis as repair and PM.
INSTALL_UPGRADE_FIELDS = [
    {
        "name": "service_description",
        "type": "text",
        "unit": None,
        "notes": "BD's Subject + Description lines (e.g. \"Software upgrade from 6.2 to 6.3\")",
    },
    {
        "name": "work_performed",
        "type": "text",
        "unit": None,
        "notes": "what was installed or upgraded, and the checks run afterwards",
    },
    {
        "name": "parts_used",
        "type": "object[]",
        "unit": None,
        "notes": "one entry per part; mirrors the form's \"Parts Used\" table — often empty for a software upgrade",
        "item_schema": [
            {"name": "part_name", "type": "text"},
            {"name": "part_number", "type": "text"},
            {"name": "qty", "type": "number"},
        ],
    },
    {"name": "labor_hours", "type": "number", "unit": "hours", "notes": "rounded total from the form's \"Labor\" line"},
    {
        "name": "verification_result",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form — mirrors preventive maintenance",
        "options": ["pass", "fail", "not verified"],
    },
]


# ---------------------------------------------------------------------------
# Model-specific templates for the two instruments from the Hebrew service
# reports (docs: claude/proposal-hebrew-translation.md). They are shaped from
# the two real forms and only for the report types those forms show, on the
# same evidence-over-guess basis as the rest of this file; any other report
# type for these models falls back to the shared row. Both forms are
# translated and accepted by a person before extraction reads them, so the
# notes below describe the accepted English.
# ---------------------------------------------------------------------------

# Cytek Aurora, almog diagnostic form (call 2046): a Hebrew form with a service
# description, notes, a parts table (Cytek part numbers start N7-), a customer
# order number, and travel and work numbers with no unit. The QC printout
# pages that follow it are ignored by the scan. The customer found travel
# useless, so no travel field exists here.
_CYTEK_PARTS = {
    "name": "parts_used",
    "type": "object[]",
    "unit": None,
    "notes": "one entry per row of the form's parts table (Cytek part numbers start N7-); empty when none",
    "item_schema": [
        {"name": "part_name", "type": "text"},
        {"name": "part_number", "type": "text"},
        {"name": "qty", "type": "number"},
    ],
}
_CYTEK_COMMON = [
    {
        "name": "service_description",
        "type": "text",
        "unit": None,
        "notes": "the form's service line (e.g. \"ESP System Upgrade\")",
    },
    {
        "name": "work_performed",
        "type": "text",
        "unit": None,
        "notes": "the actions and notes written on the form; instrument QC printouts are not part of it",
    },
    _CYTEK_PARTS,
    {
        "name": "labor_hours",
        "type": "number",
        "unit": "hours",
        "notes": "the work number on the form; an unmarked number on a work line is hours. Travel is not recorded",
    },
    {"name": "customer_order_number", "type": "text", "unit": None, "notes": "the customer's order number printed on the form"},
    {
        "name": "customer_signature_present",
        "type": "boolean",
        "unit": None,
        "notes": (
            "true only when a signature is actually drawn or written in the customer's own signature box; "
            "the customer's printed name or the box title is not a signature, an empty box is false, and "
            "the engineer's signature alone is false"
        ),
    },
    {
        "name": "verification_result",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form",
        "options": ["pass", "fail", "not verified"],
    },
]
CYTEK_AURORA_INSTALL_FIELDS = [dict(f) for f in _CYTEK_COMMON]
CYTEK_AURORA_PM_FIELDS = [dict(f) for f in _CYTEK_COMMON]

# CytoFLEX S, Rhenium form (SC26R006240): a one-page repair report with a fault
# description, a free-text repair description, a work table in clock time
# (HH:MM), a service contract level and number, no parts table, and a customer
# approval block that is often blank. Travel is empty on purpose.
CYTOFLEX_S_REPAIR_FIELDS = [
    {"name": "fault_description", "type": "text", "unit": None, "notes": "the form's fault description and details"},
    {
        "name": "root_cause",
        "type": "text",
        "unit": None,
        "notes": "the cause as the engineer states it in the repair description; empty when none is given",
    },
    {"name": "work_performed", "type": "text", "unit": None, "notes": "the repair description (what was found, replaced, and checked)"},
    {
        "name": "components_replaced",
        "type": "object[]",
        "unit": None,
        "notes": "parts named in the repair text (the form has no parts table); empty when none",
        "item_schema": [
            {"name": "part_name", "type": "text"},
            {"name": "part_number", "type": "text"},
            {"name": "qty", "type": "number"},
        ],
    },
    {
        "name": "labor_hours",
        "type": "number",
        "unit": "hours",
        "notes": "the total of the work-hours row, printed as HH:MM (01:25 is 1.42 hours); travel is not recorded",
    },
    {"name": "service_contract_level", "type": "text", "unit": None, "notes": "the form's service type, a contract level such as GOLD, not a report type"},
    {"name": "service_contract_number", "type": "text", "unit": None, "notes": "the service contract number on the form"},
    {
        "name": "customer_signature_present",
        "type": "boolean",
        "unit": None,
        "notes": (
            "true only when a signature is actually drawn or written in the customer approval block; "
            "a printed name alone is not a signature, and blank is normal and means false"
        ),
    },
    {
        "name": "fault_category",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form",
        "options": ["fluidics", "optics", "electronics", "software"],
    },
    {
        "name": "retest_result",
        "type": "enum",
        "unit": None,
        "notes": "lab-manager-assigned, not on the source form",
        "options": ["pass", "fail", "not retested"],
    },
]

# (report_type, model) -> field list. model=None means the NULL-model
# fallback row (§2, §5): applies to every model of the instrument_type unless
# a model-specific row exists for the same report_type. Repair (v0.9) and
# preventive_maintenance (v0.12) both collapsed to a single shared row once
# checked against real documents. There is no calibration type any more: lab
# users asked for it to be removed (migration a8b9c0d1e2f3).
TEMPLATE_ROWS: list[tuple[ReportType, str | None, list[dict]]] = [
    (ReportType.repair, None, REPAIR_FIELDS),
    (ReportType.preventive_maintenance, None, PM_FIELDS),
    (ReportType.installation_upgrade, None, INSTALL_UPGRADE_FIELDS),
    (ReportType.installation_upgrade, "Cytek Aurora", CYTEK_AURORA_INSTALL_FIELDS),
    (ReportType.preventive_maintenance, "Cytek Aurora", CYTEK_AURORA_PM_FIELDS),
    (ReportType.repair, "CytoFLEX S", CYTOFLEX_S_REPAIR_FIELDS),
]


def seed(db: Session) -> list[ReportTemplate]:
    """Upserts every row in TEMPLATE_ROWS, then removes any report_templates
    row for a report_type covered here that isn't in the current desired set
    — e.g. the three old per-model preventive_maintenance rows a v0.12
    redesign left behind. reports.template_id -> report_templates.id has no
    ondelete (models.py), so it defaults to RESTRICT, and
    ReportTemplate.reports is passive_deletes=True — the DB itself would
    reject deleting a stale row some existing Report still points at, so
    such a row is left in place (and its report keeps its template_id
    exactly as before) rather than crashing the whole seed run over it; this
    is a dev/eval-scale convenience (§1), not a migration tool."""
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

    stale_candidates = [
        row
        for row in db.query(ReportTemplate)
        .filter(ReportTemplate.instrument_type == "facs", ReportTemplate.report_type.in_(covered_report_types))
        .all()
        if (row.report_type, row.model) not in desired
    ]
    # A stale row some existing Report still points at can't actually be
    # deleted (see this function's docstring) — skip it instead of letting
    # db.commit() below crash the whole seed run with an unhandled
    # IntegrityError. Previously seen in practice: a leftover per-model row
    # with a finalized report attached to it.
    referenced_template_ids = {tid for (tid,) in db.query(Report.template_id).filter(Report.template_id.isnot(None)).all()}
    stale = [row for row in stale_candidates if row.id not in referenced_template_ids]
    skipped = [row for row in stale_candidates if row.id in referenced_template_ids]
    for row in stale:
        db.delete(row)

    db.commit()
    for row in created:
        db.refresh(row)
    if skipped:
        print(
            f"Left {len(skipped)} stale report_templates row(s) in place — still referenced by an existing report: "
            + ", ".join(f"{row.report_type.value}/{row.model or '(any)'}" for row in skipped)
        )
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        rows = seed(session)
        print(f"Seeded/updated {len(rows)} report_templates rows:")
        for row in rows:
            print(f"  - {row.report_type.value:26s} model={row.model or '(any)'}")
