"""The model-specific templates for the two instruments from the Hebrew service
reports (docs: claude/proposal-hebrew-translation.md): they resolve for their
own model and report type only, every other report type still falls back to the
shared row, and the fields encode the rules agreed for each form."""
from __future__ import annotations

from app.models import Instrument, ReportTemplate, ReportType
from app.services.templates import resolve_template


def _unit(db, serial):
    return db.query(Instrument).filter(Instrument.serial_number == serial).one()


def _resolve(db, unit, report_type):
    return resolve_template(db, instrument_type=unit.instrument_type, report_type=report_type, model=unit.model)


def _names(template):
    return [f["name"] for f in template.field_schema["fields"]]


def _field(template, name):
    return next(f for f in template.field_schema["fields"] if f["name"] == name)


def test_the_cytek_aurora_has_its_own_install_and_pm_templates(seeded):
    unit = _unit(seeded, "Y1033")
    for report_type in (ReportType.installation_upgrade, ReportType.preventive_maintenance):
        template = _resolve(seeded, unit, report_type)
        assert template.model == "Cytek Aurora"
        assert "customer_order_number" not in _names(template)  # treated like the contract number


def test_the_cytek_form_has_no_travel_field_and_reads_unmarked_numbers_as_hours(seeded):
    unit = _unit(seeded, "Y1033")
    template = _resolve(seeded, unit, ReportType.installation_upgrade)
    assert not any("travel" in n for n in _names(template))
    labor = _field(template, "labor_hours")
    assert labor["unit"] == "hours" and "unmarked" in labor["notes"]


def test_the_cytoflex_has_its_own_repair_template_that_converts_clock_time(seeded):
    unit = _unit(seeded, "102579")
    template = _resolve(seeded, unit, ReportType.repair)
    assert template.model == "CytoFLEX S"
    assert not {"service_contract_level", "service_contract_number", "customer_signature_present"} & set(_names(template))
    assert not any("travel" in n for n in _names(template))
    assert "HH:MM" in _field(template, "labor_hours")["notes"]


def test_other_report_types_for_these_models_fall_back_to_the_shared_rows(seeded):
    cytek = _unit(seeded, "Y1033")
    cyto = _unit(seeded, "102579")
    for unit, report_type in [
        (cytek, ReportType.repair),
        (cyto, ReportType.preventive_maintenance),
        (cyto, ReportType.installation_upgrade),
    ]:
        template = _resolve(seeded, unit, report_type)
        assert template is not None and template.model is None


def test_the_bd_models_keep_their_shared_templates(seeded):
    for serial, report_type in [("R647794E6092", ReportType.repair), ("P648282B3003", ReportType.installation_upgrade)]:
        unit = _unit(seeded, serial)
        assert _resolve(seeded, unit, report_type).model is None


def test_every_new_template_is_valid_for_the_extraction_schema(seeded):
    from app.services.extraction import _build_extract_tool  # noqa: PLC0415

    rows = seeded.query(ReportTemplate).filter(ReportTemplate.model.in_(["Cytek Aurora", "CytoFLEX S"])).all()
    assert len(rows) == 3
    for row in rows:
        assert _build_extract_tool(row.field_schema["fields"])["input_schema"]["properties"]


def test_the_classify_prompt_says_the_work_order_is_the_service_call_never_the_customers_order():
    from app.services.classification import _CLASSIFY_BODY  # noqa: PLC0415

    assert "service call or service report itself" in _CLASSIFY_BODY
    assert "customer's order number, purchase-order number and customer number are not" in _CLASSIFY_BODY
    assert "return an empty string" in _CLASSIFY_BODY.split("5. Documents from another company")[0]
