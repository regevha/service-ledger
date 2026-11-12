"""Plain-words search: a request becomes the Reports filters it names, and nothing it does not."""
from __future__ import annotations

from datetime import date

import pytest

from app.services.report_query_parse import Known, parse_search

TODAY = date(2026, 11, 7)
KNOWN = Known(
    models=[("m-aria", "FACSAria III"), ("m-fort", "LSRFortessa"), ("m-aur", "Cytek Aurora")],
    places=[("p-bar", "Bar-Ilan University")],
    instruments=[("i-1", "FACSAria III", "P69200123")],
)


def run(text: str):
    return parse_search(text, KNOWN, TODAY)


def test_type_model_and_last_month():
    p = run("repairs of the FACSAria III last month")
    assert p.filters == {"model_id": "m-aria", "report_type": "repair", "date_from": "2026-10-01", "date_to": "2026-10-31"}
    assert p.leftover == ""


def test_model_matches_without_spaces_or_case():
    assert run("facs aria iii reports").filters["model_id"] == "m-aria"
    assert run("lsr-fortessa").filters["model_id"] == "m-fort"


def test_serial_place_and_status():
    p = run("finalized reports for P69200123 at Bar-Ilan University")
    assert p.filters == {"status": "finalized", "instrument_id": "i-1", "place_id": "p-bar"}


def test_waiting_for_review_and_installations():
    assert run("what is waiting for review").filters["status"] == "extracted"
    assert run("installation reports this year").filters == {
        "report_type": "installation_upgrade",
        "date_from": "2026-01-01",
        "date_to": "2026-11-07",
    }


def test_relative_ranges():
    assert run("last 30 days").filters == {"date_from": "2026-10-08", "date_to": "2026-11-07"}
    assert run("past 3 months").filters["date_from"] == "2026-08-07"
    assert run("last week").filters == {"date_from": "2026-10-26", "date_to": "2026-11-01"}
    assert run("last year").filters == {"date_from": "2025-01-01", "date_to": "2025-12-31"}
    assert run("yesterday").filters == {"date_from": "2026-11-06", "date_to": "2026-11-06"}


def test_months_years_and_iso_dates():
    assert run("March 2026").filters == {"date_from": "2026-03-01", "date_to": "2026-03-31"}
    # A month still to come this year means last year's.
    assert run("in December").filters == {"date_from": "2025-12-01", "date_to": "2025-12-31"}
    assert run("since 2026-05-02").filters == {"date_from": "2026-05-02"}
    assert run("before 2026-05-02").filters == {"date_to": "2026-05-02"}
    assert run("in 2025").filters == {"date_from": "2025-01-01", "date_to": "2025-12-31"}


def test_lab_manager_and_leftover_text():
    p = run("reports by Dana Levi mentioning laser delay")
    assert p.filters["technician"] == "dana levi"
    assert p.filters["q"] == "laser delay"


def test_unmatched_words_stay_as_text_and_nothing_is_invented():
    p = run("sheath pressure")
    assert p.filters == {"q": "sheath pressure"}
    assert run("show me all reports").filters == {}


def test_report_type_synonyms():
    assert run("malfunction reports").filters == {"report_type": "repair"}
    assert run("broken instruments").filters["report_type"] == "repair"


def test_before_and_after_dates():
    assert run("PM before Jan 2026").filters["date_to"] == "2025-12-31"
    assert "date_from" not in run("PM before Jan 2026").filters
    assert run("repairs after March 2026").filters["date_from"] == "2026-04-01"
    assert run("repairs before 2025").filters["date_to"] == "2024-12-31"
    assert run("repairs since 2025").filters["date_from"] == "2025-01-01"
    assert "date_to" not in run("repairs since 2025").filters


def test_short_and_loose_model_names():
    assert run("what is on the Fortessa").filters["model_id"] == "m-fort"
    assert run("facs aria 3 pm").filters["model_id"] == "m-aria"
    assert run("FACSAria 3").filters["model_id"] == "m-aria"
    assert run("Aurora reports").filters["model_id"] == "m-aur"


def test_short_model_name_shared_by_two_models_is_not_guessed():
    known = Known(models=[("a", "BD Aria Sorter"), ("b", "Cytek Aria Sorter")])
    assert "model_id" not in parse_search("aria sorter reports", known, TODAY).filters


def test_not_yet_reviewed_means_waiting_for_review():
    for words in ("not reviewed", "not yet reviewed", "never reviewed", "nobody has reviewed", "unreviewed"):
        assert run(f"repairs {words}").filters == {"report_type": "repair", "status": "extracted"}, words


def test_filler_words_and_initials():
    p = run("serial P69200123 mentioning a PMT")
    assert p.filters["instrument_id"] == "i-1"
    assert p.filters["q"] == "pmt"
    assert run("reports by D. Levi").filters["technician"] == "d. levi"


def test_endpoint(client):
    r = client.post("/reports/parse-search", json={"text": "repairs last month"})
    assert r.status_code == 200
    body = r.json()
    assert body["filters"]["report_type"] == "repair"
    assert {"key": "report_type", "label": "Repair"} in body["understood"]
    assert client.post("/reports/parse-search", json={"text": ""}).status_code == 422


# ---- questions the rules read without the model: repair counts and conditions on a number ----

FIELDS = Known(
    models=[("m-aria", "FACSAria III")],
    places=[("p-bar", "Bar-Ilan University")],
    fields=["laser_delay", "laser_power", "labor_hours", "baseline_cv_percent"],
)


def run_fields(text: str):
    return parse_search(text, FIELDS, TODAY)


def test_a_condition_on_a_number_is_read_from_plain_words():
    p = run_fields("laser delay above 29")
    assert p.filters == {"number_field": "laser_delay", "number_op": "gt", "number_value": "29"}
    assert p.understood == [{"key": "field", "label": "Laser delay above 29"}]
    assert p.leftover == ""


@pytest.mark.parametrize(
    "text, op, value",
    [
        ("labor hours more than 4", "gt", "4"),
        ("labor hours > 4", "gt", "4"),
        ("labor hours at least 4.5", "gte", "4.5"),
        ("labor hours is under 2", "lt", "2"),
        ("labor hours no more than 8", "lte", "8"),
        ("labor hours equal to 3", "eq", "3"),
        ("laser power below 100 mW", "lt", "100"),  # the unit after the number is part of the condition
    ],
)
def test_the_comparisons_and_a_unit_after_the_number(text, op, value):
    p = run_fields(text)
    assert (p.filters["number_op"], p.filters["number_value"]) == (op, value)
    assert p.leftover == ""


def test_a_unit_at_the_end_of_a_field_name_can_be_left_out():
    assert run_fields("baseline cv more than 5").filters["number_field"] == "baseline_cv_percent"


def test_a_condition_goes_with_the_other_filters_and_its_number_is_not_read_as_a_year():
    p = run_fields("repairs at Bar-Ilan University where the laser delay is over 2025")
    assert p.filters == {"place_id": "p-bar", "report_type": "repair", "number_field": "laser_delay", "number_op": "gt", "number_value": "2025"}
    assert "date_from" not in p.filters


def test_a_field_that_does_not_exist_stays_text():
    p = run_fields("tubing length above 3")
    assert "number_field" not in p.filters
    assert p.leftover == "tubing length above 3"


@pytest.mark.parametrize(
    "text, op, count",
    [
        ("instruments with more than 2 repairs", "gt", 2),
        ("instruments with at least 3 repairs", "gte", 3),
        ("which instruments had fewer than 2 repairs", "lt", 2),
        ("units with at most 1 repair", "lte", 1),
        ("instruments with 3 or more repairs", "gte", 3),
        ("machines with 2 or fewer repairs", "lte", 2),
        ("instruments with exactly 4 repairs", "eq", 4),
        ("instruments with 5 repairs", "eq", 5),  # a bare number counts when the question is about instruments
        ("instruments with no repairs", "eq", 0),
        ("instruments that never had a repair", "eq", 0),
        ("instruments without any repairs", "eq", 0),
    ],
)
def test_instruments_by_repair_count_are_read_from_plain_words(text, op, count):
    p = run_fields(text)
    assert p.filters == {"repairs_op": op, "repairs_count": str(count)}
    assert p.leftover == ""
    assert [part["key"] for part in p.understood] == ["repairs"]


def test_a_repair_count_keeps_dates_model_and_place_and_says_what_it_left_out():
    p = run_fields("instruments at Bar-Ilan University with more than 2 repairs in 2025")
    assert p.filters == {"place_id": "p-bar", "date_from": "2025-01-01", "date_to": "2025-12-31", "repairs_op": "gt", "repairs_count": "2"}
    p = run_fields("instruments with more than 2 repairs signed off")
    assert "status" not in p.filters and p.filters["repairs_op"] == "gt"
    assert p.notes and "left out: status" in p.notes[0]


@pytest.mark.parametrize("text", ["3 repairs", "how many repairs did the Aria have", "repairs last month", "no repair reports for the Aria"])
def test_other_questions_about_repairs_stay_report_searches(text):
    p = run_fields(text)
    assert "repairs_op" not in p.filters
