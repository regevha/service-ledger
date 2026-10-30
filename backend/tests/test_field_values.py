"""Quarter-hour labor, choice lists, the optional flag, and migration 0007."""
import importlib.util
from pathlib import Path

import pytest

from app.models import ReportType
from app.schemas import TemplateFieldIn
from app.services.field_values import as_choice_list, normalize_values, round_to_quarter_hour
from tests.test_analytics import _make_report  # noqa: F401  (shared helper)


@pytest.mark.parametrize(
    "hours, expected",
    [(1.42, 1.5), (3.1, 3.0), (3.125, 3.25), (0.1, 0.0), (0.13, 0.25), (6.25, 6.25), (11.5, 11.5), (0, 0)],
)
def test_hours_round_to_the_nearest_quarter(hours, expected):
    assert round_to_quarter_hour(hours) == expected


def test_normalize_rounds_only_number_fields_in_hours_and_lists_choices():
    fields = [
        {"name": "labor_hours", "type": "number", "unit": "hours"},
        {"name": "temperature", "type": "number", "unit": "C"},
        {"name": "fault_category", "type": "enum[]", "options": ["a", "b"]},
        {"name": "notes", "type": "text"},
    ]
    out = normalize_values(fields, {"labor_hours": 1.42, "temperature": 21.37, "fault_category": "a", "notes": "x"})
    assert out == {"labor_hours": 1.5, "temperature": 21.37, "fault_category": ["a"], "notes": "x"}
    assert normalize_values(fields, {"labor_hours": None})["labor_hours"] is None
    assert normalize_values(fields, {"labor_hours": True})["labor_hours"] is True


def test_as_choice_list_accepts_the_old_single_string():
    assert as_choice_list("optics") == ["optics"]
    assert as_choice_list("  ") == [] and as_choice_list(None) == []
    assert as_choice_list(["a", "", 3, " b "]) == ["a", "b"]


def test_a_template_field_can_be_marked_optional():
    assert TemplateFieldIn(name="root_cause", type="text", optional=True).optional is True
    assert TemplateFieldIn(name="root_cause", type="text").optional is False


def test_seeded_repair_templates_have_choice_list_fault_category_and_optional_root_cause():
    from app import seed_templates

    for report_type, _model, fields in seed_templates.TEMPLATE_ROWS:
        by_name = {f["name"]: f for f in fields}
        if report_type is ReportType.repair:
            assert by_name["fault_category"]["type"] == "enum[]"
            assert by_name["root_cause"]["optional"] is True
        else:
            assert "fault_category" not in by_name  # repair only


def test_a_repair_with_two_categories_shares_its_hours(client, seeded):
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"labor_hours": 4, "fault_category": ["fluidics", "optics"]},
    )
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"labor_hours": 2, "fault_category": "fluidics"},  # the old one-string shape
    )
    body = client.get("/analytics/fleet").json()
    assert body["labor_hours_by_fault_category"] == {"fluidics": 4.0, "optics": 2.0}
    assert body["total_labor_hours"] == 6


def _migration():
    path = Path(__file__).resolve().parent.parent / "alembic" / "versions" / "0007_fault_category_list.py"
    spec = importlib.util.spec_from_file_location("m0007", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_converts_templates_and_values_and_back():
    m = _migration()
    schema = {"fields": [{"name": "fault_category", "type": "enum", "options": ["a"]}, {"name": "root_cause", "type": "text"}]}
    up = m._schema_up(schema)
    assert up["fields"][0]["type"] == "enum[]" and up["fields"][1]["optional"] is True
    assert m._schema_down(up) == schema
    assert m._values_up({"fault_category": "optics", "x": 1}) == {"fault_category": ["optics"], "x": 1}
    assert m._values_up({"fault_category": ""}) == {"fault_category": []}
    assert m._values_up({"fault_category": ["a"]}) == {"fault_category": ["a"]}
    assert m._values_down({"fault_category": ["a", "b"]}) == {"fault_category": "a"}
