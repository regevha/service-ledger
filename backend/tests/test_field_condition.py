"""A condition on a number in the report's fields ("laser delay above 29"): field, op and value on the Reports
list, its CSV export and the Analytics endpoints. Finalized reports only; text and empty values never pass;
a per-laser or per-detector field passes when any one of its numbers does."""
from __future__ import annotations

import pytest

from app import models


def _make(db, fields, *, status=models.ReportStatus.finalized, report_type=models.ReportType.repair):
    instrument = db.query(models.Instrument).first()
    template = db.query(models.ReportTemplate).filter(models.ReportTemplate.report_type == report_type).first()
    report = models.Report(instrument_id=instrument.id, template_id=template.id, status=status, extracted_fields=fields)
    db.add(report)
    db.commit()
    return str(report.id)


def _ids(client, **params):
    resp = client.get("/reports", params=params)
    assert resp.status_code == 200, resp.text
    return {r["id"] for r in resp.json()}


@pytest.fixture()
def data(db_session):
    return {
        "low": _make(db_session, {"laser_delay": 12}),
        "high": _make(db_session, {"laser_delay": 41.5}),
        "edge": _make(db_session, {"laser_delay": 29}),
        "text": _make(db_session, {"laser_delay": "45"}),
        "empty": _make(db_session, {"laser_delay": None}),
        "other": _make(db_session, {"laser_power": 50}),
        "per_laser": _make(db_session, {"laser_delay": {"blue": 10, "red": 33}}),
        "per_laser_low": _make(db_session, {"laser_delay": {"blue": 10, "red": 11}}),
        "draft": _make(db_session, {"laser_delay": 99}, status=models.ReportStatus.draft),
    }


def test_above(client, data):
    found = _ids(client, number_field="laser_delay", number_op="gt", number_value=29)
    assert found == {data["high"], data["per_laser"]}


def test_at_least_below_at_most_equal(client, data):
    assert _ids(client, number_field="laser_delay", number_op="gte", number_value=29) == {data["high"], data["edge"], data["per_laser"]}
    assert _ids(client, number_field="laser_delay", number_op="lt", number_value=12) == {data["per_laser"], data["per_laser_low"]}
    assert _ids(client, number_field="laser_delay", number_op="lte", number_value=12) == {data["low"], data["per_laser"], data["per_laser_low"]}
    assert _ids(client, number_field="laser_delay", number_op="eq", number_value=29) == {data["edge"]}


def test_text_empty_and_other_fields_never_pass(client, data):
    found = _ids(client, number_field="laser_delay", number_op="gt", number_value=0)
    assert data["text"] not in found and data["empty"] not in found and data["other"] not in found


def test_only_finalized_reports(client, data):
    assert data["draft"] not in _ids(client, number_field="laser_delay", number_op="gt", number_value=0)


def test_combines_with_other_filters(client, data):
    assert _ids(client, number_field="laser_delay", number_op="gt", number_value=29, status="finalized", report_type="repair") == {data["high"], data["per_laser"]}
    assert _ids(client, number_field="laser_delay", number_op="gt", number_value=29, report_type="installation_upgrade") == set()


def test_a_field_name_is_never_read_as_a_path(client, data):
    assert _ids(client, number_field='laser_delay") || true //', number_op="gt", number_value=0) == set()
    assert _ids(client, number_field="$.laser_delay", number_op="gt", number_value=0) == set()


@pytest.mark.parametrize(
    "params",
    [{"number_field": "laser_delay"}, {"number_op": "gt", "number_value": 3}, {"number_field": "laser_delay", "number_op": "gt"}, {"number_field": "laser_delay", "number_op": "near", "number_value": 3}, {"number_field": " ", "number_op": "gt", "number_value": 3}],
)
def test_a_partial_or_unknown_condition_is_refused(client, params):
    resp = client.get("/reports", params=params)
    assert resp.status_code == 422
    assert resp.json()["detail"]


def test_export_matches_the_list(client, data):
    resp = client.get("/reports/export", params={"number_field": "laser_delay", "number_op": "gt", "number_value": 29})
    assert resp.status_code == 200
    rows = resp.text.strip().splitlines()[1:]
    assert {r.split(",")[0] for r in rows} == {data["high"], data["per_laser"]}


def test_analytics_uses_the_same_condition(client, data):
    resp = client.get("/analytics/fleet", params={"number_field": "laser_delay", "number_op": "gt", "number_value": 29})
    assert resp.status_code == 200, resp.text
    assert client.get("/analytics/fleet", params={"number_field": "laser_delay"}).status_code == 422


def test_saved_filter_keeps_the_condition(client):
    body = {"name": "Slow lasers", "filters": {"number_field": "laser_delay", "number_op": "gt", "number_value": 29}}
    resp = client.post("/saved-report-filters", json=body)
    assert resp.status_code in (200, 201), resp.text
    assert resp.json()["filters"] == {"number_field": "laser_delay", "number_op": "gt", "number_value": 29}
    assert client.post("/saved-report-filters", json={"name": "Bad", "filters": {"number_field": "laser_delay"}}).status_code == 422
