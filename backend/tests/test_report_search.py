"""Free-text search (proposal-report-search.md): word-based, text fields only,
finalized reports only, ranked by best match, with excerpts."""
from __future__ import annotations

import itertools
import re

import pytest

from app import models
from app.services import report_search

_counter = itertools.count(1)


def _make(
    db,
    *,
    status=models.ReportStatus.finalized,
    fields=None,
    technician="Lab Manager",
    report_type=models.ReportType.repair,
    model="LSRFortessa",
):
    """A report on the seeded instrument of `model` with the seeded template for
    `report_type`, written straight to the database (as the app's own write
    paths do), so the search_text listener is what fills the search column."""
    instrument = db.query(models.Instrument).filter(models.Instrument.model == model).first()
    template = (
        db.query(models.ReportTemplate)
        .filter(models.ReportTemplate.report_type == report_type)
        .filter((models.ReportTemplate.model == model) | (models.ReportTemplate.model.is_(None)))
        .first()
    )
    report = models.Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields=fields or {},
        technician_name=technician,
    )
    db.add(report)
    db.commit()
    return report


def _ids(client, **params):
    res = client.get("/reports", params=params)
    assert res.status_code == 200, res.text
    return [r["id"] for r in res.json()]


def _search(client, q, **params):
    return _ids(client, q=q, **params)


def test_finds_words_in_text_fields_and_table_cells(client, db_session):
    a = _make(db_session, fields={"fault_description": "Clogged waste line on the sorter"})
    b = _make(
        db_session,
        fields={"components_replaced": [{"part_name": "Face Seal", "part_number": "641922", "qty": 1}]},
    )
    assert _search(client, "clogged") == [str(a.id)]
    assert _search(client, "face seal") == [str(b.id)]
    # A part number is a text cell, found as a whole token only.
    assert _search(client, "641922") == [str(b.id)]
    assert _search(client, "6419") == []


def test_instrument_model_and_serial_are_searchable_but_not_the_lab_manager(client, db_session):
    r = _make(db_session, fields={"fault_description": "noise"}, technician="Zebulon Quimby")
    serial = db_session.get(models.Instrument, r.instrument_id).serial_number
    assert _search(client, "LSRFortessa") == [str(r.id)]
    assert str(r.id) in _search(client, serial)
    assert _search(client, "Zebulon") == []


def test_numbers_dropdowns_and_booleans_are_not_searched(client, db_session):
    _make(
        db_session,
        fields={
            "fault_description": "plain text",
            "fault_category": "fluidics",
            "labor_hours": 7.25,
            "components_replaced": [{"part_name": "Seal", "part_number": "A1", "qty": 31337}],
        },
    )
    assert _search(client, "fluidics") == []  # dropdown value
    assert _search(client, "7.25") == []  # number field
    assert _search(client, "31337") == []  # numeric table cell
    assert len(_search(client, "plain")) == 1


def test_only_finalized_reports_are_returned(client, db_session):
    words = {"fault_description": "bubble in the sheath line"}
    final = _make(db_session, fields=words)
    for status in (
        models.ReportStatus.draft,
        models.ReportStatus.classified,
        models.ReportStatus.extracted,
        models.ReportStatus.in_review,
    ):
        _make(db_session, status=status, fields=words)
    assert _search(client, "bubble") == [str(final.id)]


def test_a_report_leaves_search_when_it_is_no_longer_finalized_and_returns_when_finalized_again(client, db_session):
    r = _make(db_session, fields={"fault_description": "leak at the flow cell"})
    assert _search(client, "leak") == [str(r.id)]
    r.status = models.ReportStatus.in_review  # un-finalized: a draft again
    db_session.commit()
    assert _search(client, "leak") == []
    r.status = models.ReportStatus.finalized
    db_session.commit()
    assert _search(client, "leak") == [str(r.id)]


def test_status_filter_other_than_finalized_gives_an_empty_result(client, db_session):
    _make(db_session, fields={"fault_description": "alignment drift"})
    assert len(_search(client, "alignment")) == 1
    assert _search(client, "alignment", status="draft") == []
    assert len(_search(client, "alignment", status="finalized")) == 1


def test_all_words_must_appear_and_phrases_and_exclusions_work(client, db_session):
    both = _make(db_session, fields={"fault_description": "waste line clogged and pump noisy"})
    only_waste = _make(db_session, fields={"fault_description": "waste container full"})
    assert _search(client, "waste clogged") == [str(both.id)]
    assert set(_search(client, "waste")) == {str(both.id), str(only_waste.id)}
    assert _search(client, '"waste line"') == [str(both.id)]
    assert _search(client, '"line waste"') == []
    assert _search(client, "waste -clogged") == [str(only_waste.id)]


def test_search_is_case_insensitive(client, db_session):
    r = _make(db_session, fields={"fault_description": "Replaced the LASER module"})
    assert _search(client, "laser") == [str(r.id)]
    assert _search(client, "LASER") == [str(r.id)]


def test_words_like_not_and_no_are_kept(client, db_session):
    r = _make(db_session, fields={"fault_description": "not retested, no leak"})
    assert _search(client, "not retested") == [str(r.id)]


@pytest.mark.parametrize("q", ["   ", ""])
def test_blank_query_is_ignored(client, db_session, q):
    _make(db_session, fields={"fault_description": "anything"})
    assert len(_search(client, q)) == len(_ids(client))


def test_too_short_or_too_long_is_a_422_and_odd_punctuation_is_not(client, db_session):
    _make(db_session, fields={"fault_description": "anything"})
    assert client.get("/reports", params={"q": "a"}).status_code == 422
    assert client.get("/reports", params={"q": "x" * 201}).status_code == 422
    for odd in ['"unclosed', "((", "!!", "a:b", "'", "- -", "\\"]:
        assert client.get("/reports", params={"q": odd + "xx"}).status_code == 200, odd


def test_combines_with_the_other_filters(client, db_session):
    fort = _make(db_session, fields={"fault_description": "pump noise"}, model="LSRFortessa")
    aria = _make(db_session, fields={"fault_description": "pump noise"}, model="FACSAria III")
    inst = db_session.get(models.Instrument, fort.instrument_id)
    assert set(_search(client, "pump")) == {str(fort.id), str(aria.id)}
    assert _search(client, "pump", instrument_id=str(inst.id)) == [str(fort.id)]
    assert _search(client, "pump", report_type="repair", technician="lab man") != []
    assert _search(client, "pump", report_type="calibration") == []


def test_best_match_comes_first(client, db_session):
    weak = _make(db_session, fields={"fault_description": "the pump was inspected"})
    strong = _make(
        db_session,
        fields={
            "fault_description": "pump failure",
            "root_cause": "pump seal worn",
            "work_performed": "replaced the pump, tested the pump",
        },
    )
    assert _search(client, "pump")[0] == str(strong.id)
    assert _search(client, "pump") == [str(strong.id), str(weak.id)]


def test_export_follows_the_same_search(client, db_session):
    hit = _make(db_session, fields={"fault_description": "unique-marker-xyz leak"})
    _make(db_session, fields={"fault_description": "something else"})
    res = client.get("/reports/export", params={"q": "unique-marker-xyz"})
    assert res.status_code == 200
    body = res.text
    assert str(hit.id) in body
    assert body.count("\n") == 2  # header + one row
    assert client.get("/reports/export", params={"q": "a"}).status_code == 422


def test_excerpt_pieces_mark_the_matched_words_and_carry_no_markup(client, db_session):
    _make(db_session, fields={"work_performed": "Replaced the <b>waste</b> line and tested"})
    item = client.get("/reports", params={"q": "waste"}).json()[0]
    assert item["matched_field"] == "Work performed"
    pieces = item["snippet"]
    assert [p["text"] for p in pieces if p["matched"]] == ["waste"]
    assert "".join(p["text"] for p in pieces) == "Replaced the <b>waste</b> line and tested"
    # Rows without a query have no excerpt.
    assert client.get("/reports").json()[0]["snippet"] is None


def test_long_text_is_cut_to_a_window_with_ellipses(client, db_session):
    long = ("word " * 60) + "needle" + (" word" * 60)
    _make(db_session, fields={"work_performed": long})
    pieces = client.get("/reports", params={"q": "needle"}).json()[0]["snippet"]
    text = "".join(p["text"] for p in pieces)
    assert text.startswith("… ") and text.endswith(" …")
    assert len(text) < 200 and "needle" in text


def test_search_text_follows_edits_instrument_and_template_changes(client, db_session):
    r = _make(db_session, fields={"fault_description": "first wording"})
    assert _search(client, "first") == [str(r.id)]

    # Editing the fields through the API refreshes it (finalized reports stay editable today).
    res = client.patch(f"/reports/{r.id}/fields", json={"extracted_fields": {"fault_description": "second wording"}})
    assert res.status_code == 200
    assert _search(client, "first") == []
    assert _search(client, "second") == [str(r.id)]

    # Changing the instrument's model refreshes the reports on it.
    inst = db_session.get(models.Instrument, r.instrument_id)
    client.patch(f"/instruments/{inst.id}", json={"model": "Zorblax 9000"})
    assert _search(client, "zorblax") == [str(r.id)]
    assert _search(client, "LSRFortessa") == []


def test_search_text_is_rebuilt_when_a_template_stops_listing_a_text_field(client, db_session):
    r = _make(db_session, fields={"fault_description": "visible words", "work_performed": "hidden words"})
    assert _search(client, "hidden") == [str(r.id)]
    template = db_session.get(models.ReportTemplate, r.template_id)
    schema = dict(template.field_schema)
    schema["fields"] = [f for f in schema["fields"] if f["name"] != "work_performed"]
    template.field_schema = schema
    db_session.commit()
    assert _search(client, "hidden") == []
    assert _search(client, "visible") == [str(r.id)]


def test_builder_unit_cases():
    schema = {
        "fields": [
            {"name": "work_performed", "type": "text"},
            {"name": "fault_category", "type": "enum", "options": ["x"]},
            {"name": "labor_hours", "type": "number"},
            {
                "name": "components_replaced",
                "type": "object[]",
                "item_schema": [
                    {"name": "part_name", "type": "text"},
                    {"name": "qty", "type": "number"},
                ],
            },
        ]
    }
    fields = {
        "work_performed": "Did it",
        "fault_category": "optics",
        "labor_hours": 3,
        "components_replaced": [{"part_name": "Lens", "qty": 4}],
        "not_in_schema": "ignored",
    }
    text = report_search.build_search_text(schema, fields, "Model", "SER1")
    assert text == "Model\nSER1\nDid it\nLens"
    assert report_search.build_search_text(None, {}, None, None) is None


def test_a_report_made_through_the_worker_pipeline_becomes_searchable_once_finalized(client, run_worker):
    """The real intake path (upload, classify, extract by the worker, finalize)
    fills the search column too, not only direct database writes."""
    report = client.post("/reports", json={"technician_name": "Pipeline"}).json()
    up = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("repair_fortessa.pdf", b"%PDF-1.4 pipeline search", "application/pdf")},
    ).json()
    client.post(f"/attachments/{up['id']}/classify")
    run_worker()
    client.post(f"/attachments/{up['id']}/extract")
    run_worker()
    fields = client.get(f"/reports/{report['id']}").json()["extracted_fields"]
    template_id = client.get(f"/reports/{report['id']}").json()["template_id"]
    template = client.get(f"/report-templates/{template_id}").json()
    text_names = [f["name"] for f in template["field_schema"]["fields"] if f["type"] == "text"]
    value = next(fields[n] for n in text_names if isinstance(fields.get(n), str) and fields[n].strip())
    word = re.findall(r"[A-Za-z]{4,}", value)[0]

    assert _search(client, word) == []  # extracted but not finalized yet
    assert client.post(f"/reports/{report['id']}/finalize").status_code == 200
    assert report["id"] in _search(client, word)
