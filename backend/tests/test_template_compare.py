"""Coverage for the side-by-side template comparison
(app/services/template_compare.py and GET /report-templates/compare), phase 1
of proposal-template-comparison.md.

The matching tests build their own rows under a private instrument type
("lab"), so the seeded fleet's templates never change what they see. The
endpoint tests also compare the real seeded templates, because those are the
pairs the feature exists for."""
from __future__ import annotations

import uuid

from app.models import ReportTemplate, ReportType
from app.services.template_compare import (
    DIFFERS,
    ONLY_LEFT,
    ONLY_RIGHT,
    SAME,
    compare_templates,
    differing_attributes,
    normalize_name,
)


def _f(name, type="text", unit=None, notes=None, **extra):
    return {"name": name, "type": type, "unit": unit, "notes": notes, **extra}


def _template(db, fields, model=None, report_type=ReportType.repair, instrument_type="lab"):
    row = ReportTemplate(
        instrument_type=instrument_type, report_type=report_type, model=model, field_schema={"fields": fields}
    )
    db.add(row)
    db.commit()
    return row


def _statuses(comparison):
    return [(r.name, r.status) for r in comparison.rows]


# ---------- matching ----------


def test_normalize_name_ignores_case_spaces_underscores_and_hyphens():
    assert normalize_name("Labor hours") == normalize_name("labor_hours") == normalize_name("LABOR-HOURS")
    assert normalize_name("labor_hours") != normalize_name("labor_hour")


def test_identical_templates_are_all_same(db_session):
    fields = [_f("a"), _f("b", "number", unit="h")]
    comparison = compare_templates(_template(db_session, fields, "X"), _template(db_session, fields, "Y"))
    assert _statuses(comparison) == [("a", SAME), ("b", SAME)]
    assert all(r.differences == [] for r in comparison.rows)


def test_fields_on_one_side_only_are_flagged_on_that_side(db_session):
    left = _template(db_session, [_f("shared"), _f("left_only")], "L")
    right = _template(db_session, [_f("shared"), _f("right_only")], "R")
    comparison = compare_templates(left, right)
    assert _statuses(comparison) == [("shared", SAME), ("left_only", ONLY_LEFT), ("right_only", ONLY_RIGHT)]
    only_left = comparison.rows[1]
    assert only_left.left["name"] == "left_only" and only_left.right is None
    only_right = comparison.rows[2]
    assert only_right.right["name"] == "right_only" and only_right.left is None


def test_rows_follow_the_left_order_then_the_right_only_fields(db_session):
    left = _template(db_session, [_f("c"), _f("a"), _f("b")], "L")
    right = _template(db_session, [_f("z"), _f("b"), _f("y"), _f("c")], "R")
    assert [r.name for r in compare_templates(left, right).rows] == ["c", "a", "b", "z", "y"]


def test_names_match_across_spelling_and_the_difference_is_reported(db_session):
    left = _template(db_session, [_f("labor_hours", "number")], "L")
    right = _template(db_session, [_f("Labor Hours", "number")], "R")
    (row,) = compare_templates(left, right).rows
    assert row.status == DIFFERS
    assert row.differences == ["name"]
    assert row.left["name"] == "labor_hours" and row.right["name"] == "Labor Hours"


def test_two_fields_with_one_normalized_name_are_matched_in_order(db_session):
    left = _template(db_session, [_f("note"), _f("Note", notes="second")], "L")
    right = _template(db_session, [_f("note")], "R")
    assert _statuses(compare_templates(left, right)) == [("note", SAME), ("Note", ONLY_LEFT)]


def test_an_empty_template_compares_against_a_full_one(db_session):
    comparison = compare_templates(_template(db_session, [], "L"), _template(db_session, [_f("a"), _f("b")], "R"))
    assert _statuses(comparison) == [("a", ONLY_RIGHT), ("b", ONLY_RIGHT)]
    assert (comparison.left_count, comparison.right_count) == (0, 2)


# ---------- what counts as a difference ----------


def test_type_difference_is_reported():
    assert differing_attributes(_f("a", "text"), _f("a", "number")) == ["type"]


def test_unit_difference_is_reported():
    assert differing_attributes(_f("a", "number", unit="h"), _f("a", "number", unit="min")) == ["unit"]


def test_notes_difference_is_reported():
    assert differing_attributes(_f("a", notes="BD's subject line"), _f("a", notes="Cytek's summary")) == ["notes"]


def test_missing_notes_and_blank_notes_are_the_same():
    assert differing_attributes(_f("a", notes=None), _f("a", notes="  ")) == []
    assert differing_attributes(_f("a", unit=None), _f("a", unit="")) == []


def test_notes_ignore_whitespace_runs():
    assert differing_attributes(_f("a", notes="two   words\n"), _f("a", notes="two words")) == []


def test_option_lists_compare_as_sets_so_order_alone_is_not_a_difference():
    left = _f("r", "enum", options=["pass", "fail"])
    assert differing_attributes(left, _f("r", "enum", options=["fail", "pass"])) == []
    assert differing_attributes(left, _f("r", "enum", options=["pass", "fail", "n/a"])) == ["options"]


def test_table_columns_compare_by_name_type_and_order():
    cols = [{"name": "part", "type": "text"}, {"name": "qty", "type": "number"}]
    left = _f("p", "object[]", item_schema=cols)
    assert differing_attributes(left, _f("p", "object[]", item_schema=list(cols))) == []
    assert differing_attributes(left, _f("p", "object[]", item_schema=cols[::-1])) == ["item_schema"]
    assert differing_attributes(left, _f("p", "object[]", item_schema=cols[:1])) == ["item_schema"]


def test_several_differences_are_listed_in_a_fixed_order():
    left = _f("A", "text", unit="x", notes="one")
    right = _f("a", "number", unit="y", notes="two")
    assert differing_attributes(left, right) == ["name", "type", "unit", "notes"]


def test_a_differing_row_keeps_both_definitions(db_session):
    left = _template(db_session, [_f("a", notes="left note")], "L")
    right = _template(db_session, [_f("a", notes="right note")], "R")
    (row,) = compare_templates(left, right).rows
    assert row.status == DIFFERS and row.differences == ["notes"]
    assert (row.left["notes"], row.right["notes"]) == ("left note", "right note")


def test_nothing_is_written(db_session):
    left = _template(db_session, [_f("a")], "L")
    right = _template(db_session, [_f("b")], "R")
    before = db_session.query(ReportTemplate).count()
    compare_templates(left, right)
    assert db_session.query(ReportTemplate).count() == before
    assert left.field_schema == {"fields": [_f("a")]}


# ---------- the endpoint ----------


def _seeded(client, report_type, model):
    rows = client.get("/report-templates/all").json()
    (row,) = [r for r in rows if r["report_type"] == report_type and r["model"] == model]
    return row


def _compare(client, left, right):
    return client.get("/report-templates/compare", params={"left": left["id"], "right": right["id"]})


def test_endpoint_compares_the_generic_and_cytoflex_repair_templates(client):
    generic = _seeded(client, "repair", None)
    cytoflex = _seeded(client, "repair", "CytoFLEX S")
    resp = _compare(client, generic, cytoflex)
    assert resp.status_code == 200
    body = resp.json()
    assert body["left"]["id"] == generic["id"] and body["right"]["id"] == cytoflex["id"]
    # The generic template is a strict subset: 7 shared, 3 only on the CytoFLEX S side.
    assert body["summary"] == {
        "left_count": 7,
        "right_count": 10,
        "shared": 7,
        "same": 2,
        "differs": 5,
        "only_left": 0,
        "only_right": 3,
    }
    only_right = [r["name"] for r in body["rows"] if r["status"] == "only_right"]
    assert only_right == ["service_contract_level", "service_contract_number", "customer_signature_present"]
    differing = {r["name"]: r["differences"] for r in body["rows"] if r["status"] == "differs"}
    assert differing == {
        "fault_description": ["notes"],
        "root_cause": ["notes"],
        "work_performed": ["notes"],
        "components_replaced": ["notes"],
        "labor_hours": ["notes"],
    }


def test_endpoint_shows_the_two_cytek_aurora_templates_as_identical(client):
    install = _seeded(client, "installation_upgrade", "Cytek Aurora")
    pm = _seeded(client, "preventive_maintenance", "Cytek Aurora")
    body = _compare(client, install, pm).json()
    assert body["summary"]["same"] == body["summary"]["shared"] == 7
    assert body["summary"]["differs"] == body["summary"]["only_left"] == body["summary"]["only_right"] == 0


def test_endpoint_shows_generic_and_cytek_pm_with_fields_on_both_sides(client):
    generic = _seeded(client, "preventive_maintenance", None)
    cytek = _seeded(client, "preventive_maintenance", "Cytek Aurora")
    body = _compare(client, generic, cytek).json()
    assert [r["name"] for r in body["rows"] if r["status"] == "only_left"] == ["components_replaced", "calibrated_tools"]
    assert [r["name"] for r in body["rows"] if r["status"] == "only_right"] == [
        "parts_used",
        "customer_order_number",
        "customer_signature_present",
    ]


def test_endpoint_calibration_templates_share_almost_nothing(client):
    generic = _seeded(client, "calibration", None)
    spectral = _seeded(client, "calibration", "FACSDiscover S8")
    summary = _compare(client, generic, spectral).json()["summary"]
    assert summary["shared"] == 1
    assert summary["only_left"] == summary["only_right"] == 5


def test_endpoint_summary_counts_add_up(client):
    generic = _seeded(client, "repair", None)
    cytoflex = _seeded(client, "repair", "CytoFLEX S")
    body = _compare(client, cytoflex, generic).json()
    s = body["summary"]
    assert s["shared"] == s["same"] + s["differs"]
    assert len(body["rows"]) == s["shared"] + s["only_left"] + s["only_right"]
    assert s["left_count"] == s["shared"] + s["only_left"]
    assert s["right_count"] == s["shared"] + s["only_right"]


def test_endpoint_swapping_sides_swaps_the_only_columns(client):
    generic = _seeded(client, "repair", None)
    cytoflex = _seeded(client, "repair", "CytoFLEX S")
    swapped = _compare(client, cytoflex, generic).json()["summary"]
    assert (swapped["only_left"], swapped["only_right"]) == (3, 0)


def test_endpoint_comparing_a_template_with_itself_is_all_same(client):
    generic = _seeded(client, "repair", None)
    s = _compare(client, generic, generic).json()["summary"]
    assert s["same"] == s["shared"] == 7


def test_endpoint_unknown_template_is_404(client):
    generic = _seeded(client, "repair", None)
    missing = {"id": str(uuid.uuid4())}
    assert _compare(client, generic, missing).status_code == 404
    assert _compare(client, missing, generic).status_code == 404


def test_endpoint_different_instrument_types_are_refused(client):
    generic = _seeded(client, "repair", None)
    assert client.post("/instrument-types", json={"display_name": "Plate reader"}).status_code == 201
    key = [t["key"] for t in client.get("/instrument-types").json() if t["display_name"] == "Plate reader"][0]
    other = client.post(
        "/report-templates",
        json={
            "instrument_type": key,
            "report_type": "repair",
            "model": None,
            "fields": [{"name": "fault_description", "type": "text"}],
        },
    ).json()
    resp = _compare(client, generic, other)
    assert resp.status_code == 422
    assert "same instrument type" in resp.json()["detail"]


def test_endpoint_requires_both_ids_and_valid_uuids(client):
    generic = _seeded(client, "repair", None)
    assert client.get("/report-templates/compare").status_code == 422
    assert client.get("/report-templates/compare", params={"left": generic["id"]}).status_code == 422
    assert client.get("/report-templates/compare", params={"left": "nope", "right": generic["id"]}).status_code == 422


def test_endpoint_is_not_swallowed_by_the_template_id_route(client):
    generic = _seeded(client, "repair", None)
    # If "compare" were read as a template id this would be a 422 for a bad UUID path, not a 200.
    assert _compare(client, generic, generic).status_code == 200


def test_endpoint_does_not_change_any_template(client):
    before = client.get("/report-templates/all").json()
    generic = _seeded(client, "repair", None)
    cytoflex = _seeded(client, "repair", "CytoFLEX S")
    _compare(client, generic, cytoflex)
    assert client.get("/report-templates/all").json() == before


def test_repeated_names_on_both_sides_pair_first_with_first(db_session):
    left = _template(db_session, [_f("note", notes="one"), _f("Note", notes="two")], "L")
    right = _template(db_session, [_f("note", notes="one"), _f("NOTE", notes="two")], "R")
    rows = compare_templates(left, right).rows
    assert [(r.left["notes"], r.right["notes"]) for r in rows] == [("one", "one"), ("two", "two")]
    assert [r.differences for r in rows] == [[], ["name"]]
