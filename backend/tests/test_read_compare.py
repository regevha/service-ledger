"""services/read_compare.py: the one "was it kept?" rule (SL-70)."""
from __future__ import annotations

import pytest

from app.services.read_compare import blank, is_free_text, same_value


@pytest.mark.parametrize(
    "read, kept",
    [
        ("Replaced the pinch valve.", "replaced the pinch valve"),
        ("Replaced   the pinch\nvalve", "Replaced the pinch valve"),
        ("Cleaned flow cell; checked laser, delay", "cleaned flow cell checked laser delay"),
        ("החלפת לייזר.", "החלפת לייזר"),
    ],
)
def test_free_text_ignores_case_spacing_and_punctuation(read, kept):
    assert same_value("work_performed", read, kept)


@pytest.mark.parametrize(
    "read, kept",
    [
        ("Replaced 2 valves", "Replaced 3 valves"),
        ("Replaced the valve", "Replaced the filter"),
        ("valve replaced the", "replaced the valve"),
        ("3.5 hours", "35 hours"),
        ("", "something"),
    ],
)
def test_free_text_still_sees_a_changed_number_word_or_order(read, kept):
    assert not same_value("root_cause", read, kept)


def test_other_fields_are_compared_exactly_apart_from_edge_spaces():
    assert same_value("serial_number", " ZA1234 ", "ZA1234")
    assert not same_value("serial_number", "za1234", "ZA1234")
    assert not same_value("serial_number", "ZA-1234", "ZA1234")
    assert not same_value("fault_category", "Fluidics", "fluidics")


def test_non_text_values_are_compared_exactly():
    assert same_value("labor_hours", 2.5, 2.5) and not same_value("labor_hours", 2.5, 3)
    parts = [{"part_name": "Valve", "qty": 1}]
    assert same_value("components_replaced", parts, [{"part_name": "Valve", "qty": 1}])
    assert not same_value("components_replaced", parts, [{"part_name": "valve", "qty": 1}])


def test_which_fields_are_free_text_and_what_is_blank():
    assert {f for f in ("work_performed", "fault_description", "root_cause", "service_description") if is_free_text(f)} == {
        "work_performed", "fault_description", "root_cause", "service_description"
    }
    assert not is_free_text("serial_number")
    assert all(blank(v) for v in (None, "", "  ", [], {}))
    assert not blank(0) and not blank("x")
