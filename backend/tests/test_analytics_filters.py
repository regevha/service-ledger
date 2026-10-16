"""The optional filters on the analytics endpoints (instrument, report type and
a date range), shared by GET /analytics/fleet, /analytics/models and
/analytics/models/trend. They mean what they mean on the Reports list: the type
is the template's report type, the dates are the report date (a report with no
date drops out once a bound is given), and everything combines.

Report rows are built through the ORM, as in test_analytics.py.
"""
from __future__ import annotations

from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType

FORTESSA = "R647794E6092"
ARIA = "P648282B3003"


def _unit(db, serial):
    return db.query(Instrument).filter(Instrument.serial_number == serial).one()


def _report(db, serial, report_type, *, when, labor=None, parts=(), status=ReportStatus.finalized):
    instrument = _unit(db, serial)
    template = (
        db.query(ReportTemplate)
        .filter(ReportTemplate.report_type == report_type)
        .filter((ReportTemplate.model == instrument.model) | (ReportTemplate.model.is_(None)))
        .first()
    )
    fields: dict = {}
    if labor is not None:
        fields["labor_hours"] = labor
    if parts:
        fields["components_replaced"] = [{"part_name": name, "part_number": None, "qty": qty} for name, qty in parts]
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields=fields,
        report_date=when,
    )
    db.add(report)
    db.commit()
    return report


def _data(db):
    """Six finalized reports (one undated, one calibration) and a draft that never counts."""
    _report(db, FORTESSA, ReportType.repair, when=date(2026, 1, 10), labor=2, parts=[("Lens", 1)])
    _report(db, FORTESSA, ReportType.preventive_maintenance, when=date(2026, 3, 15), labor=3, parts=[("Filter", 2)])
    _report(db, ARIA, ReportType.repair, when=date(2026, 6, 20), labor=5, parts=[("Lens", 4)])
    _report(db, ARIA, ReportType.repair, when=None, labor=7)  # no report date
    _report(db, FORTESSA, ReportType.calibration, when=date(2026, 2, 20))
    _report(db, FORTESSA, ReportType.repair, when=date(2026, 2, 1), labor=100, status=ReportStatus.draft)


def _fleet(client, **params):
    resp = client.get("/analytics/fleet", params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _parts(body):
    return {p["part_name"]: p["total_qty"] for p in body["parts_replaced"]}


def test_without_filters_every_finalized_report_counts_and_drafts_do_not(client, db_session):
    _data(db_session)
    body = _fleet(client)
    assert body["finalized_report_count"] == 5  # the draft is not counted
    assert body["total_labor_hours"] == 17.0  # 2 + 3 + 5 + 7
    assert _parts(body) == {"Lens": 5.0, "Filter": 2.0}


def test_the_report_type_filter_keeps_only_that_type(client, db_session):
    _data(db_session)
    repair = _fleet(client, report_type="repair")
    assert repair["finalized_report_count"] == 3
    assert repair["total_labor_hours"] == 14.0
    assert _parts(repair) == {"Lens": 5.0}
    assert repair["pass_fail_by_report_type"]["preventive_maintenance"]["total"] == 0

    calibration = _fleet(client, report_type="calibration")
    assert calibration["finalized_report_count"] == 1
    assert calibration["total_labor_hours"] == 0.0


def test_the_date_range_is_inclusive_and_leaves_out_reports_with_no_date(client, db_session):
    _data(db_session)
    q1 = _fleet(client, date_from="2026-01-01", date_to="2026-03-31")
    assert q1["finalized_report_count"] == 3  # Jan repair, Feb calibration, Mar PM; not the undated one
    assert q1["total_labor_hours"] == 5.0

    assert _fleet(client, date_from="2026-03-15")["total_labor_hours"] == 8.0  # the PM on the day itself, and June
    assert _fleet(client, date_to="2026-01-10")["total_labor_hours"] == 2.0
    one_day = _fleet(client, date_from="2026-01-10", date_to="2026-01-10")
    assert one_day["finalized_report_count"] == 1 and one_day["total_labor_hours"] == 2.0


def test_the_instrument_filter_keeps_one_unit_and_lists_only_it(client, db_session):
    _data(db_session)
    fortessa = _unit(db_session, FORTESSA)
    body = _fleet(client, instrument_id=str(fortessa.id))
    assert body["finalized_report_count"] == 3  # repair, PM, calibration
    assert body["total_labor_hours"] == 5.0
    assert [row["serial_number"] for row in body["labor_hours_by_instrument"]] == [FORTESSA]
    assert body["labor_hours_by_instrument"][0]["total_labor_hours"] == 5.0


def test_filters_combine(client, db_session):
    _data(db_session)
    fortessa = _unit(db_session, FORTESSA)
    body = _fleet(client, instrument_id=str(fortessa.id), report_type="repair", date_to="2026-12-31")
    assert body["finalized_report_count"] == 1
    assert body["total_labor_hours"] == 2.0
    assert _parts(body) == {"Lens": 1.0}


def test_other_instruments_still_appear_with_zeros_when_only_type_or_date_filter(client, db_session):
    # Same as with no filter: units with nothing to show are listed, at zero.
    _data(db_session)
    body = _fleet(client, report_type="preventive_maintenance")
    rows = {r["serial_number"]: r for r in body["labor_hours_by_instrument"]}
    assert len(rows) == 5
    assert rows[FORTESSA]["total_labor_hours"] == 3.0
    assert rows[ARIA]["total_labor_hours"] == 0.0


def test_a_filter_that_matches_nothing_gives_zeros_not_an_error(client, db_session):
    _data(db_session)
    body = _fleet(client, date_from="2030-01-01")
    assert body["finalized_report_count"] == 0
    assert body["total_labor_hours"] == 0.0
    assert body["parts_replaced"] == []
    assert body["pass_fail_by_report_type"]["repair"]["total"] == 0
    assert body["pass_fail_by_report_type"]["preventive_maintenance"]["total"] == 0


def test_dates_the_wrong_way_round_and_bad_values_are_refused_on_every_endpoint(client):
    reversed_dates = {"date_from": "2026-06-01", "date_to": "2026-01-01"}
    assert client.get("/analytics/fleet", params=reversed_dates).status_code == 422
    assert client.get("/analytics/models", params=reversed_dates).status_code == 422
    trend = {"model": "LSRFortessa", "field": "labor_hours", **reversed_dates}
    assert client.get("/analytics/models/trend", params=trend).status_code == 422

    assert client.get("/analytics/fleet", params={"report_type": "nope"}).status_code == 422
    assert client.get("/analytics/fleet", params={"instrument_id": "not-a-uuid"}).status_code == 422
    assert client.get("/analytics/fleet", params={"date_from": "yesterday"}).status_code == 422


# ---------- the same-model comparison and its trend ----------


def _second_fortessa(client, serial="R647794E6099"):
    resp = client.post(
        "/instruments",
        json={"name": "Fortessa B", "model": "LSRFortessa", "manufacturer": "TestCo", "serial_number": serial},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _comparison_unit(body, model, serial):
    group = next(m for m in body if m["model"] == model)
    return next(u for u in group["units"] if u["serial_number"] == serial)


def test_the_comparison_follows_the_type_and_date_filters_and_keeps_every_unit(client, db_session):
    _second_fortessa(client)
    _data(db_session)

    everything = client.get("/analytics/models").json()
    assert _comparison_unit(everything, "LSRFortessa", FORTESSA)["finalized_report_count"] == 3

    repair = client.get("/analytics/models", params={"report_type": "repair"}).json()
    fortessa = _comparison_unit(repair, "LSRFortessa", FORTESSA)
    assert fortessa["finalized_report_count"] == 1 and fortessa["total_labor_hours"] == 2.0
    # The second unit has no matching reports, but it is still there, at zero.
    assert _comparison_unit(repair, "LSRFortessa", "R647794E6099")["finalized_report_count"] == 0

    early = client.get("/analytics/models", params={"date_to": "2026-02-28"}).json()
    assert _comparison_unit(early, "LSRFortessa", FORTESSA)["finalized_report_count"] == 2  # Jan repair, Feb calibration


def test_the_instrument_filter_leaves_only_that_unit_in_the_comparison(client, db_session):
    other = _second_fortessa(client)
    _data(db_session)
    fortessa = _unit(db_session, FORTESSA)

    body = client.get("/analytics/models", params={"instrument_id": str(fortessa.id)}).json()
    assert [m["model"] for m in body] == ["LSRFortessa"]
    assert [u["serial_number"] for u in body[0]["units"]] == [FORTESSA]

    other_only = client.get("/analytics/models", params={"instrument_id": other}).json()
    assert [u["serial_number"] for u in other_only[0]["units"]] == ["R647794E6099"]
    assert other_only[0]["units"][0]["finalized_report_count"] == 0


def test_the_trend_follows_the_filters(client, db_session):
    _second_fortessa(client)
    _data(db_session)
    params = {"model": "LSRFortessa", "field": "labor_hours"}

    def points(body, serial):
        series = next(s for s in body["series"] if s["serial_number"] == serial)
        return series["points"]

    everything = client.get("/analytics/models/trend", params=params).json()
    assert len(points(everything, FORTESSA)) == 2  # the repair and the PM

    early = client.get("/analytics/models/trend", params={**params, "date_to": "2026-02-01"}).json()
    assert len(points(early, FORTESSA)) == 1
    assert len(everything["series"]) == len(early["series"]) == 2  # units stay listed

    fortessa = _unit(db_session, FORTESSA)
    one_unit = client.get("/analytics/models/trend", params={**params, "instrument_id": str(fortessa.id)}).json()
    assert [s["serial_number"] for s in one_unit["series"]] == [FORTESSA]

    # An instrument of another model has no series for this model.
    aria = _unit(db_session, ARIA)
    assert client.get("/analytics/models/trend", params={**params, "instrument_id": str(aria.id)}).status_code == 404


# ---------- the manufacturer filter ----------


def _set_manufacturer(db, serial, name):
    unit = _unit(db, serial)
    unit.manufacturer = name
    db.commit()


def test_the_manufacturer_filter_keeps_that_makers_instruments_and_lists_only_them(client, db_session):
    _data(db_session)
    _set_manufacturer(db_session, FORTESSA, "BD Biosciences")
    _set_manufacturer(db_session, ARIA, "Other Maker")

    body = _fleet(client, manufacturer="bd biosciences ")  # case and spaces do not matter
    assert body["finalized_report_count"] == 3
    assert body["total_labor_hours"] == 5.0
    assert [r["serial_number"] for r in body["labor_hours_by_instrument"]] == [FORTESSA]

    other = _fleet(client, manufacturer="Other Maker")
    assert other["finalized_report_count"] == 2 and other["total_labor_hours"] == 12.0

    assert _fleet(client, manufacturer="Nobody")["finalized_report_count"] == 0


def test_the_manufacturer_filter_combines_with_the_others_and_reaches_the_comparison(client, db_session):
    _data(db_session)
    _set_manufacturer(db_session, FORTESSA, "BD Biosciences")
    _set_manufacturer(db_session, ARIA, "Other Maker")

    body = _fleet(client, manufacturer="BD Biosciences", report_type="repair")
    assert body["finalized_report_count"] == 1 and body["total_labor_hours"] == 2.0

    models_body = client.get("/analytics/models", params={"manufacturer": "Other Maker"}).json()
    assert [m["model"] for m in models_body] == [_unit(db_session, ARIA).model]

    trend = client.get(
        "/analytics/models/trend",
        params={"model": _unit(db_session, FORTESSA).model, "field": "labor_hours", "manufacturer": "Other Maker"},
    )
    assert trend.status_code == 404  # no unit of that model from that maker
