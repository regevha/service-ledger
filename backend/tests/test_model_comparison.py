"""Tests for GET /analytics/models and GET /analytics/models/trend: units of
the same model side by side, from finalized reports only. Report rows are
built through the ORM (see test_analytics.py for why)."""
from __future__ import annotations

from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def _second_fortessa(client, serial="R647794E6099"):
    resp = client.post(
        "/instruments",
        json={"name": "Fortessa B", "model": "LSRFortessa", "serial_number": serial},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _fortessas(db_session):
    return db_session.query(Instrument).filter(Instrument.model == "LSRFortessa").order_by(Instrument.serial_number).all()


def _make_report(db_session, instrument, report_type, fields, *, status=ReportStatus.finalized, when=None):
    template = (
        db_session.query(ReportTemplate)
        .filter(ReportTemplate.report_type == report_type)
        .filter((ReportTemplate.model == instrument.model) | (ReportTemplate.model.is_(None)))
        .first()
    )
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields=fields,
        report_date=when,
    )
    db_session.add(report)
    db_session.commit()
    return report


def _unit(body, model, serial):
    group = next(m for m in body if m["model"] == model)
    return next(u for u in group["units"] if u["serial_number"] == serial)


def test_every_model_is_listed_with_its_units_even_with_no_reports(client):
    body = client.get("/analytics/models").json()

    assert [m["model"] for m in body] == ["FACSAria III", "FACSDiscover S8", "LSRFortessa"]
    assert all(len(m["units"]) == 1 for m in body)
    unit = body[0]["units"][0]
    assert unit["finalized_report_count"] == 0 and unit["total_labor_hours"] == 0.0 and unit["last_report_date"] is None
    assert body[0]["trend_fields"] == []


def test_two_units_of_the_same_model_are_compared_side_by_side(client, db_session):
    _second_fortessa(client)
    a, b = _fortessas(db_session)
    _make_report(db_session, a, ReportType.repair, {
        "labor_hours": 4, "retest_result": "pass",
        "components_replaced": [{"part_name": "O-ring", "qty": 2}, {"part_name": "Filter", "qty": 1}],
    }, when=date(2026, 1, 5))
    _make_report(db_session, a, ReportType.repair, {"labor_hours": 2.5, "retest_result": "fail"}, when=date(2026, 3, 1))
    _make_report(db_session, b, ReportType.preventive_maintenance, {"labor_hours": 6, "verification_result": "pass"})
    # Not finalized: must not count anywhere.
    _make_report(db_session, b, ReportType.repair, {"labor_hours": 99}, status=ReportStatus.extracted)

    body = client.get("/analytics/models").json()
    fortessa = next(m for m in body if m["model"] == "LSRFortessa")
    assert [u["serial_number"] for u in fortessa["units"]] == [a.serial_number, b.serial_number]

    ua = _unit(body, "LSRFortessa", a.serial_number)
    assert ua["finalized_report_count"] == 2
    assert ua["labor_report_count"] == 2 and ua["total_labor_hours"] == 6.5
    assert ua["parts_replaced_qty"] == 3
    assert ua["repair_results"] == {"pass_count": 1, "fail_count": 1, "other_count": 0, "total": 2}
    assert ua["preventive_maintenance_results"]["total"] == 0
    assert ua["last_report_date"] == "2026-03-01"

    ub = _unit(body, "LSRFortessa", b.serial_number)
    assert ub["finalized_report_count"] == 1 and ub["total_labor_hours"] == 6
    assert ub["preventive_maintenance_results"] == {"pass_count": 1, "fail_count": 0, "other_count": 0, "total": 1}
    assert ub["repair_results"]["total"] == 0


def test_units_of_different_models_are_never_mixed(client, db_session):
    a, = _fortessas(db_session)
    aria = db_session.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    _make_report(db_session, a, ReportType.repair, {"labor_hours": 3})

    body = client.get("/analytics/models").json()

    assert _unit(body, "LSRFortessa", a.serial_number)["total_labor_hours"] == 3
    assert _unit(body, "FACSAria III", aria.serial_number)["total_labor_hours"] == 0


def test_trend_fields_are_the_numeric_fields_the_models_reports_carry(client, db_session):
    _second_fortessa(client)
    a, b = _fortessas(db_session)
    _make_report(db_session, a, ReportType.calibration, {"fluidics_pressure_psi": 12.5})

    fortessa = next(m for m in client.get("/analytics/models").json() if m["model"] == "LSRFortessa")

    names = {f["name"] for f in fortessa["trend_fields"]}
    assert "fluidics_pressure_psi" in names and "baseline_cv_percent" in names
    assert "components_replaced" not in names


def test_model_trend_returns_one_series_per_unit_finalized_only(client, db_session):
    _second_fortessa(client)
    a, b = _fortessas(db_session)
    _make_report(db_session, a, ReportType.calibration, {"fluidics_pressure_psi": 12.5}, when=date(2026, 1, 1))
    _make_report(db_session, a, ReportType.calibration, {"fluidics_pressure_psi": 13.0}, when=date(2026, 2, 1))
    _make_report(db_session, b, ReportType.calibration, {"fluidics_pressure_psi": 11.0}, when=date(2026, 1, 15))
    _make_report(db_session, b, ReportType.calibration, {"fluidics_pressure_psi": 50.0}, status=ReportStatus.in_review)

    resp = client.get("/analytics/models/trend", params={"model": "LSRFortessa", "field": "fluidics_pressure_psi"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "LSRFortessa" and body["field"] == "fluidics_pressure_psi"
    by_serial = {s["serial_number"]: [p["value"] for p in s["points"]] for s in body["series"]}
    assert by_serial == {a.serial_number: [12.5, 13.0], b.serial_number: [11.0]}


def test_model_trend_supports_detector_maps(client, db_session):
    a, = _fortessas(db_session)
    _make_report(db_session, a, ReportType.calibration, {"baseline_cv_percent": {"violet": 3.1, "blue": 2.0}})

    body = client.get("/analytics/models/trend", params={"model": "LSRFortessa", "field": "baseline_cv_percent"}).json()

    assert body["series"][0]["points"][0]["value"] == {"violet": 3.1, "blue": 2.0}


def test_model_trend_for_an_unknown_model_is_404_and_a_missing_field_is_422(client):
    assert client.get("/analytics/models/trend", params={"model": "Nope", "field": "x"}).status_code == 404
    assert client.get("/analytics/models/trend", params={"model": "LSRFortessa"}).status_code == 422


def test_model_trend_for_a_field_with_no_data_gives_empty_series(client):
    body = client.get("/analytics/models/trend", params={"model": "LSRFortessa", "field": "fluidics_pressure_psi"}).json()

    assert len(body["series"]) == 1 and body["series"][0]["points"] == []
