"""The privacy rule's safety net (app/services/privacy.py) and its use in extraction."""
import pytest

from app.services import extraction
from app.services.privacy import scrub_text, scrub_values


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Air bubble in bleach line. By A. Engineer on 18/04/2021", "Air bubble in bleach line"),
        ("11 Month Recurring / SMX0000001", "11 Month Recurring"),
        ("Engineer: Jane Doe replaced the filter", "engineer replaced the filter"),
        ("Signed by John Smith. System ready", "System ready"),
        ("Contract number: 12345678 expired", "expired"),
        ("Write to jane.doe@example.com or call +49 170 1234567 today", "Write to or call today"),
        ("Call 03-555 1234 now", "Call now"),
    ],
)
def test_names_and_contract_details_are_removed(text, expected):
    assert scrub_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Replaced part 34363910 on 06/05/2026",
        "Checked by the engineer after repair",
        "Fluidics pressure 12.5 psi, flow 1.0 ml/min",
        "Replaced the sheath filter and primed the system three times.",
        "",
    ],
)
def test_ordinary_text_is_left_alone(text):
    assert scrub_text(text) == text


def test_scrub_values_covers_text_fields_and_table_cells_and_reports_what_changed():
    fields = [
        {"name": "work_performed", "type": "text"},
        {"name": "components_replaced", "type": "object[]"},
        {"name": "labor_hours", "type": "number"},
        {"name": "root_cause", "type": "text"},
    ]
    values = {
        "work_performed": "Replaced O-ring. By A. Engineer on 18/04/2021",
        "components_replaced": [{"part_name": "Filter, Engineer: Jane Doe", "part_number": "641922", "qty": 1}],
        "labor_hours": 2.5,
        "root_cause": "Worn seal",
    }
    out, changed = scrub_values(fields, values)
    assert changed == {"work_performed", "components_replaced"}
    assert out["work_performed"] == "Replaced O-ring"
    assert out["components_replaced"][0]["part_name"] == "Filter, engineer"
    assert out["components_replaced"][0]["part_number"] == "641922" and out["labor_hours"] == 2.5


def test_a_field_the_check_changed_is_left_doubtful(monkeypatch):
    template_fields = [{"name": "work_performed", "type": "text", "unit": None, "notes": None}]

    class T:
        field_schema = {"fields": template_fields}

    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", False)
    monkeypatch.setattr(
        extraction,
        "_stub_extract",
        lambda a, t: extraction.ExtractionResult(
            {"work_performed": "Replaced seal. By A. Engineer on 18/04/2021"}, {"work_performed": 0.95, "report_date": 0.9}, None
        ),
    )
    result = extraction.extract(object(), T())
    assert result.extracted_fields["work_performed"] == "Replaced seal"
    assert result.field_confidences["work_performed"] == 0.5
    assert result.field_confidences["report_date"] == 0.9


def test_the_prompt_states_the_rule():
    assert "no person's name and no contract detail may appear in any field, free text included" in extraction._EXTRACT_PROMPT_HEADER
    assert '"the engineer" or "the customer"' in extraction._EXTRACT_PROMPT_HEADER
