"""Coverage for the field alias groups (app/routers/field_aliases.py) and for
the "possible match" rows they add to the template comparison
(proposal-template-comparison.md, phase 2).

The test database is built from the models, not by the migration, so it starts
with no groups; the migration's two seeded groups have their own test at the
bottom."""
from __future__ import annotations

import uuid

from app.models import FieldAliasGroup, FieldAliasName, ReportTemplate, ReportType
from app.services.field_aliases import load_alias_index
from app.services.template_compare import (
    ONLY_LEFT,
    ONLY_RIGHT,
    POSSIBLE_MATCH,
    SAME,
    compare_templates,
)


def _create(client, names, label=None):
    return client.post("/field-aliases", json={"label": label, "names": names})


def _f(name, type="text", unit=None, notes=None, **extra):
    return {"name": name, "type": type, "unit": unit, "notes": notes, **extra}


def _template(db, fields, model=None, report_type=ReportType.repair):
    row = ReportTemplate(instrument_type="lab", report_type=report_type, model=model, field_schema={"fields": fields})
    db.add(row)
    db.commit()
    return row


def _group(db, names, label=None):
    group = FieldAliasGroup(label=label)
    group.names = [FieldAliasName(name=n, normalized="".join(c for c in n.lower() if c.isalnum()), position=i) for i, n in enumerate(names)]
    db.add(group)
    db.commit()
    return group


# ---------- the API ----------


def test_list_starts_empty(client):
    assert client.get("/field-aliases").json() == []


def test_create_and_list_a_group(client):
    resp = _create(client, ["retest_result", "verification_result"], "Check result")
    assert resp.status_code == 201
    body = resp.json()
    assert body["label"] == "Check result"
    assert body["names"] == ["retest_result", "verification_result"]
    assert uuid.UUID(body["id"])
    assert client.get("/field-aliases").json() == [body]


def test_a_group_needs_no_label(client):
    resp = _create(client, ["a_one", "a_two"])
    assert resp.status_code == 201 and resp.json()["label"] is None


def test_blank_label_is_stored_as_none(client):
    assert _create(client, ["a_one", "a_two"], "   ").json()["label"] is None


def test_names_and_label_are_trimmed_and_order_is_kept(client):
    body = _create(client, ["  zeta ", "alpha", "mid"], "  Spaced  ").json()
    assert body["names"] == ["zeta", "alpha", "mid"]
    assert body["label"] == "Spaced"


def test_a_group_needs_at_least_two_names(client):
    assert _create(client, ["only_one"]).status_code == 422
    assert _create(client, []).status_code == 422


def test_blank_names_are_rejected(client):
    assert _create(client, ["good", "  "]).status_code == 422
    assert _create(client, ["good", ""]).status_code == 422


def test_a_name_needs_a_letter_or_digit(client):
    assert _create(client, ["good", "___"]).status_code == 422


def test_names_equal_once_spelling_is_ignored_are_one_name(client):
    resp = _create(client, ["Labor hours", "labor_hours"])
    assert resp.status_code == 422
    assert "same name" in resp.text
    assert client.get("/field-aliases").json() == []


def test_too_many_or_too_long_names_are_rejected(client):
    assert _create(client, [f"name_{i}" for i in range(21)]).status_code == 422
    assert _create(client, [f"name_{i}" for i in range(20)]).status_code == 201
    assert _create(client, ["x" * 101, "ok_name"]).status_code == 422
    assert _create(client, ["x" * 100, "ok_name_2"]).status_code == 201
    assert _create(client, ["lbl_a", "lbl_b"], "y" * 101).status_code == 422


def test_a_name_in_another_group_is_refused_with_that_group_named(client):
    _create(client, ["retest_result", "verification_result"], "Check result")
    resp = _create(client, ["Verification Result", "another"])
    assert resp.status_code == 409
    assert "Check result" in resp.json()["detail"]
    assert len(client.get("/field-aliases").json()) == 1


def test_a_clash_without_a_label_names_the_members(client):
    _create(client, ["one_a", "one_b"])
    detail = _create(client, ["one_b", "two"]).json()["detail"]
    assert "one_a, one_b" in detail


def test_replace_changes_label_and_names(client):
    group = _create(client, ["a_one", "a_two"], "Old").json()
    resp = client.put(f"/field-aliases/{group['id']}", json={"label": "New", "names": ["a_two", "a_three", "a_one"]})
    assert resp.status_code == 200
    assert resp.json()["label"] == "New"
    assert resp.json()["names"] == ["a_two", "a_three", "a_one"]
    assert client.get("/field-aliases").json()[0]["names"] == ["a_two", "a_three", "a_one"]


def test_replace_can_add_a_name_to_a_group_read_in_an_earlier_request(client):
    # Found by the Playwright run: each request has its own session, so the
    # group's names were not loaded when the replace started.
    group = _create(client, ["keep_one", "keep_two"], "L").json()
    client.get("/field-aliases")
    resp = client.put(f"/field-aliases/{group['id']}", json={"label": "L", "names": ["keep_one", "keep_two", "keep_three"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["names"] == ["keep_one", "keep_two", "keep_three"]
    assert client.get("/field-aliases").json()[0]["names"] == ["keep_one", "keep_two", "keep_three"]


def test_replace_may_keep_its_own_names(client):
    group = _create(client, ["keep_a", "keep_b"]).json()
    assert client.put(f"/field-aliases/{group['id']}", json={"names": ["keep_a", "keep_b"]}).status_code == 200


def test_replace_cannot_take_a_name_from_another_group(client):
    _create(client, ["taken_a", "taken_b"])
    group = _create(client, ["free_a", "free_b"]).json()
    resp = client.put(f"/field-aliases/{group['id']}", json={"names": ["free_a", "taken_b"]})
    assert resp.status_code == 409
    assert client.get("/field-aliases").json()[1]["names"] == ["free_a", "free_b"]


def test_replace_frees_the_names_it_drops(client):
    group = _create(client, ["drop_a", "drop_b"]).json()
    client.put(f"/field-aliases/{group['id']}", json={"names": ["drop_a", "new_b"]})
    assert _create(client, ["drop_b", "elsewhere"]).status_code == 201


def test_replace_validates_like_create(client):
    group = _create(client, ["v_a", "v_b"]).json()
    assert client.put(f"/field-aliases/{group['id']}", json={"names": ["v_a"]}).status_code == 422


def test_replace_unknown_group_is_404(client):
    assert client.put(f"/field-aliases/{uuid.uuid4()}", json={"names": ["a_a", "b_b"]}).status_code == 404


def test_delete_removes_the_group_and_frees_its_names(client):
    group = _create(client, ["gone_a", "gone_b"]).json()
    assert client.delete(f"/field-aliases/{group['id']}").status_code == 204
    assert client.get("/field-aliases").json() == []
    assert _create(client, ["gone_a", "gone_b"]).status_code == 201


def test_delete_unknown_group_is_404(client):
    assert client.delete(f"/field-aliases/{uuid.uuid4()}").status_code == 404


def test_deleting_a_group_deletes_its_names_rows(client, db_session):
    group = _create(client, ["row_a", "row_b"]).json()
    assert db_session.query(FieldAliasName).count() == 2
    client.delete(f"/field-aliases/{group['id']}")
    db_session.expire_all()
    assert db_session.query(FieldAliasName).count() == 0


def test_aliases_do_not_touch_any_template(client):
    before = client.get("/report-templates/all").json()
    _create(client, ["fault_description", "root_cause"])
    assert client.get("/report-templates/all").json() == before


def test_route_is_not_swallowed(client):
    assert client.get("/field-aliases").status_code == 200


# ---------- the index ----------


def test_index_maps_every_spelling_to_its_group(db_session):
    group = _group(db_session, ["retest_result", "verification_result"], "Check")
    index = load_alias_index(db_session)
    assert set(index) == {"retestresult", "verificationresult"}
    assert index["retestresult"] == index["verificationresult"]
    assert index["retestresult"].id == group.id and index["retestresult"].label == "Check"
    assert index["retestresult"].names == ("retest_result", "verification_result")


# ---------- possible matches in the comparison ----------


def _statuses(comparison):
    return [(r.name, r.status) for r in comparison.rows]


def test_aliased_fields_on_opposite_sides_are_a_possible_match(db_session):
    _group(db_session, ["retest_result", "verification_result"], "Check")
    left = _template(db_session, [_f("fault"), _f("retest_result", "enum", options=["pass", "fail"])], "L")
    right = _template(db_session, [_f("fault"), _f("verification_result", "enum", options=["pass", "retest"])], "R")
    comparison = compare_templates(left, right, load_alias_index(db_session))
    assert _statuses(comparison) == [("fault", SAME), ("retest_result", POSSIBLE_MATCH)]
    row = comparison.rows[1]
    assert row.left["name"] == "retest_result" and row.right["name"] == "verification_result"
    assert row.concept.label == "Check"
    assert row.differences == ["name", "options"]


def test_without_an_alias_they_stay_one_field_each_side(db_session):
    left = _template(db_session, [_f("retest_result")], "L")
    right = _template(db_session, [_f("verification_result")], "R")
    assert _statuses(compare_templates(left, right, load_alias_index(db_session))) == [
        ("retest_result", ONLY_LEFT),
        ("verification_result", ONLY_RIGHT),
    ]
    assert _statuses(compare_templates(left, right)) == _statuses(compare_templates(left, right, {}))


def test_a_possible_match_keeps_the_left_position_and_drops_the_right_tail_row(db_session):
    _group(db_session, ["a_name", "b_name"])
    left = _template(db_session, [_f("x1"), _f("a_name"), _f("x2")], "L")
    right = _template(db_session, [_f("b_name"), _f("y1")], "R")
    comparison = compare_templates(left, right, load_alias_index(db_session))
    assert _statuses(comparison) == [("x1", ONLY_LEFT), ("a_name", POSSIBLE_MATCH), ("x2", ONLY_LEFT), ("y1", ONLY_RIGHT)]


def test_an_exact_name_match_wins_over_an_alias(db_session):
    # Both templates have retest_result; the alias must not pair left's
    # retest_result with right's verification_result.
    _group(db_session, ["retest_result", "verification_result"])
    left = _template(db_session, [_f("retest_result")], "L")
    right = _template(db_session, [_f("retest_result"), _f("verification_result")], "R")
    assert _statuses(compare_templates(left, right, load_alias_index(db_session))) == [
        ("retest_result", SAME),
        ("verification_result", ONLY_RIGHT),
    ]


def test_each_right_field_is_paired_at_most_once(db_session):
    _group(db_session, ["a_name", "b_name", "c_name"])
    left = _template(db_session, [_f("a_name"), _f("c_name")], "L")
    right = _template(db_session, [_f("b_name")], "R")
    assert _statuses(compare_templates(left, right, load_alias_index(db_session))) == [
        ("a_name", POSSIBLE_MATCH),
        ("c_name", ONLY_LEFT),
    ]


def test_names_in_different_groups_do_not_pair(db_session):
    _group(db_session, ["a_name", "a_other"])
    _group(db_session, ["b_name", "b_other"])
    left = _template(db_session, [_f("a_name")], "L")
    right = _template(db_session, [_f("b_name")], "R")
    assert _statuses(compare_templates(left, right, load_alias_index(db_session))) == [
        ("a_name", ONLY_LEFT),
        ("b_name", ONLY_RIGHT),
    ]


def test_aliases_match_whatever_the_spelling_in_the_template(db_session):
    _group(db_session, ["retest_result", "verification_result"])
    left = _template(db_session, [_f("Retest Result")], "L")
    right = _template(db_session, [_f("Verification-Result")], "R")
    assert _statuses(compare_templates(left, right, load_alias_index(db_session))) == [("Retest Result", POSSIBLE_MATCH)]


def test_two_fields_of_a_group_in_one_template_pair_with_the_right_ones_in_order(db_session):
    _group(db_session, ["p_one", "p_two", "p_three"])
    left = _template(db_session, [_f("p_one"), _f("p_two")], "L")
    right = _template(db_session, [_f("p_three")], "R")
    rows = compare_templates(left, right, load_alias_index(db_session)).rows
    assert [(r.name, r.status) for r in rows] == [("p_one", POSSIBLE_MATCH), ("p_two", ONLY_LEFT)]
    assert rows[0].right["name"] == "p_three"


def _two_pm_templates(db):
    """Two maintenance-shaped templates whose parts fields are worded differently."""
    left = _template(db, [_f("service_description"), _f("components_replaced", "object[]"), _f("tools", "object[]")], None, ReportType.preventive_maintenance)
    right = _template(db, [_f("service_description"), _f("parts_used", "object[]"), _f("order_ref")], "Other", ReportType.preventive_maintenance)
    return {"left": str(left.id), "right": str(right.id)}


def test_endpoint_reports_possible_matches_with_the_concept_and_a_count(client, db_session):
    params = _two_pm_templates(db_session)
    _create(client, ["components_replaced", "parts_used"], "Parts")
    body = client.get("/report-templates/compare", params=params).json()
    match = [r for r in body["rows"] if r["status"] == "possible_match"]
    assert [m["name"] for m in match] == ["components_replaced"]
    assert match[0]["right"]["name"] == "parts_used"
    assert match[0]["concept"]["label"] == "Parts"
    assert match[0]["concept"]["names"] == ["components_replaced", "parts_used"]
    assert body["summary"]["possible_match"] == 1
    # Each side had one field only it has besides the pair; the pair is now a possible match.
    assert [r["name"] for r in body["rows"] if r["status"] == "only_left"] == ["tools"]
    assert [r["name"] for r in body["rows"] if r["status"] == "only_right"] == ["order_ref"]
    assert body["summary"]["shared"] + body["summary"]["only_left"] + body["summary"]["possible_match"] == body["summary"]["left_count"]
    assert body["summary"]["shared"] + body["summary"]["only_right"] + body["summary"]["possible_match"] == body["summary"]["right_count"]


def test_endpoint_without_aliases_has_no_possible_matches(client, db_session):
    params = _two_pm_templates(db_session)
    body = client.get("/report-templates/compare", params=params).json()
    assert body["summary"]["possible_match"] == 0
    assert all(r["concept"] is None for r in body["rows"])


def test_deleting_a_group_removes_its_possible_matches(client, db_session):
    params = _two_pm_templates(db_session)
    group = _create(client, ["components_replaced", "parts_used"]).json()
    assert client.get("/report-templates/compare", params=params).json()["summary"]["possible_match"] == 1
    client.delete(f"/field-aliases/{group['id']}")
    assert client.get("/report-templates/compare", params=params).json()["summary"]["possible_match"] == 0
