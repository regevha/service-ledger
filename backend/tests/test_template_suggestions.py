"""Coverage for the closest-template suggestion
(app/services/templates.py's suggest_templates and GET
/report-templates/suggestions), phase 1 of proposal-template-suggestion.md.

The ranking tests insert their own rows under a private instrument type
("lab"), so the seeded fleet's templates never change what they see. Each
rule has a test that fails if the rule is removed (the mutation checks run
for this PR are listed in its description)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import ReportTemplate, ReportType
from app.services.templates import (
    TIER_GENERIC,
    TIER_OTHER_MODEL,
    TIER_SAME_FAMILY,
    TIER_SAME_MODEL,
    suggest_templates,
)

BASE_TIME = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _fields(n: int) -> dict:
    return {"fields": [{"name": f"f{i}", "type": "text", "unit": None, "notes": None} for i in range(n)]}


def _add(db, model, n_fields=3, report_type=ReportType.repair, instrument_type="lab", age_days=0):
    row = ReportTemplate(
        instrument_type=instrument_type,
        report_type=report_type,
        model=model,
        field_schema=_fields(n_fields),
        created_at=BASE_TIME + timedelta(days=age_days),
    )
    db.add(row)
    db.commit()
    return row


def _suggest(db, model, report_type="repair", instrument_type="lab", limit=3):
    return suggest_templates(db, instrument_type=instrument_type, report_type=report_type, model=model, limit=limit)


def test_other_report_types_are_never_offered(db_session):
    _add(db_session, "FACSAria III", report_type=ReportType.installation_upgrade)
    _add(db_session, None, report_type=ReportType.preventive_maintenance)
    assert _suggest(db_session, "FACSAria Fusion") == []


def test_other_instrument_types_are_never_offered(db_session):
    _add(db_session, "FACSAria III", instrument_type="microscope")
    assert _suggest(db_session, "FACSAria Fusion") == []


def test_family_beats_generic_beats_unrelated(db_session):
    unrelated = _add(db_session, "CytoFLEX S", n_fields=20)
    generic = _add(db_session, None, n_fields=10)
    family = _add(db_session, "FACSAria III", n_fields=2)
    ranked = _suggest(db_session, "FACSAria Fusion")
    assert [s.template.id for s in ranked] == [family.id, generic.id, unrelated.id]
    assert [s.score // 10 for s in ranked] == [TIER_SAME_FAMILY, TIER_GENERIC, TIER_OTHER_MODEL]


def test_a_shared_brand_prefix_inside_one_word_is_not_a_family(db_session):
    # "FACSDiscover" and "FACSAria" both start with "FACS", but they are
    # different words, so this is only a same-report-type candidate.
    _add(db_session, "FACSAria III")
    ranked = _suggest(db_session, "FACSDiscover S8")
    assert [s.score // 10 for s in ranked] == [TIER_OTHER_MODEL]


def test_more_shared_leading_words_rank_higher(db_session):
    near = _add(db_session, "BD FACSymphony A5", n_fields=3)
    far = _add(db_session, "BD FACSAria III", n_fields=9)
    ranked = _suggest(db_session, "BD FACSymphony S6")
    assert [s.template.id for s in ranked] == [near.id, far.id]
    assert ranked[0].score == TIER_SAME_FAMILY * 10 + 2
    assert ranked[1].score == TIER_SAME_FAMILY * 10 + 1


def test_same_model_spelled_differently_ranks_first(db_session):
    _add(db_session, "FACSAria Fusion", n_fields=15)
    respelled = _add(db_session, "facsaria-iii", n_fields=1)
    ranked = _suggest(db_session, "FACSAria III")
    assert ranked[0].template.id == respelled.id
    assert ranked[0].score // 10 == TIER_SAME_MODEL
    assert "same model" in ranked[0].reason


def test_the_row_that_already_has_this_model_is_left_out(db_session):
    # It is the template that resolves today, and a second one with the same
    # model cannot be saved, so offering it would lead to a 409.
    _add(db_session, "FACSAria III")
    other = _add(db_session, None)
    ranked = _suggest(db_session, "FACSAria III")
    assert [s.template.id for s in ranked] == [other.id]


def test_a_missing_model_offers_the_generic_template_and_the_rest(db_session):
    generic = _add(db_session, None)
    specific = _add(db_session, "FACSAria III", n_fields=8)
    ranked = _suggest(db_session, None)
    assert [s.template.id for s in ranked] == [generic.id, specific.id]


def test_ties_go_to_the_template_with_more_fields_then_the_older_one(db_session):
    small = _add(db_session, "FACSAria III", n_fields=2, age_days=0)
    big = _add(db_session, "FACSAria Fusion", n_fields=9, age_days=5)
    older = _add(db_session, "FACSAria IV", n_fields=9, age_days=1)
    ranked = _suggest(db_session, "FACSAria LX")
    assert [s.template.id for s in ranked] == [older.id, big.id, small.id]


def test_the_order_is_stable_across_calls(db_session):
    for i in range(4):
        _add(db_session, f"FACSAria V{i}", n_fields=3, age_days=0)
    first = [s.template.id for s in _suggest(db_session, "FACSAria X", limit=4)]
    second = [s.template.id for s in _suggest(db_session, "FACSAria X", limit=4)]
    assert first == second


def test_model_matching_ignores_case_and_punctuation(db_session):
    family = _add(db_session, "facsaria-III")
    ranked = _suggest(db_session, "FACSARIA  Fusion")
    assert ranked[0].template.id == family.id
    assert ranked[0].score // 10 == TIER_SAME_FAMILY


def test_limit_caps_the_list(db_session):
    for i in range(5):
        _add(db_session, f"Model{i}")
    assert len(_suggest(db_session, "Other", limit=2)) == 2
    assert len(_suggest(db_session, "Other", limit=10)) == 5


def test_each_suggestion_carries_a_reason_and_a_field_count(db_session):
    _add(db_session, "FACSAria III", n_fields=7)
    (only,) = _suggest(db_session, "FACSAria Fusion")
    assert only.field_count == 7
    assert "FACSAria family" in only.reason
    assert "FACSAria III" in only.reason


def test_nothing_is_written(db_session):
    _add(db_session, "FACSAria III")
    before = db_session.query(ReportTemplate).count()
    _suggest(db_session, "FACSAria Fusion")
    assert db_session.query(ReportTemplate).count() == before


# ---------- the endpoint ----------


def test_endpoint_returns_ranked_suggestions(client):
    # The seed has a generic repair template and a CytoFLEX S repair template.
    resp = client.get("/report-templates/suggestions", params={"report_type": "repair", "model": "CytoFLEX LX"})
    assert resp.status_code == 200
    body = resp.json()
    assert [s["template"]["model"] for s in body] == ["CytoFLEX S", None]
    assert set(body[0]) == {"template", "score", "reason", "field_count"}
    assert body[0]["field_count"] == len(body[0]["template"]["field_schema"]["fields"])
    assert "CytoFLEX family" in body[0]["reason"]


def test_endpoint_is_not_swallowed_by_the_template_id_route(client):
    resp = client.get("/report-templates/suggestions", params={"report_type": "installation_upgrade"})
    assert resp.status_code == 200


def test_endpoint_requires_a_report_type_and_a_valid_one(client):
    assert client.get("/report-templates/suggestions").status_code == 422
    assert client.get("/report-templates/suggestions", params={"report_type": "nope"}).status_code == 422


def test_endpoint_validates_limit(client):
    assert client.get("/report-templates/suggestions", params={"report_type": "repair", "limit": 0}).status_code == 422
    assert client.get("/report-templates/suggestions", params={"report_type": "repair", "limit": 11}).status_code == 422
    resp = client.get("/report-templates/suggestions", params={"report_type": "repair", "limit": 1})
    assert len(resp.json()) == 1


def test_endpoint_returns_an_empty_list_for_an_unknown_instrument_type(client):
    resp = client.get("/report-templates/suggestions", params={"report_type": "repair", "instrument_type": "nothing"})
    assert resp.status_code == 200
    assert resp.json() == []


def test_endpoint_does_not_change_any_template(client):
    before = client.get("/report-templates/all").json()
    client.get("/report-templates/suggestions", params={"report_type": "repair", "model": "FACSAria Fusion"})
    assert client.get("/report-templates/all").json() == before


def test_a_family_is_named_as_the_model_writes_it(db_session):
    _add(db_session, "CytoFLEX-S Plus")
    (only,) = _suggest(db_session, "CytoFLEX-S Max")
    assert "same CytoFLEX-S family" in only.reason
