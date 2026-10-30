"""Models plan step 4, part B: reliability figures for one model."""
from __future__ import annotations

import uuid
from datetime import date

from app import models


def _unit(client, serial, model="Zeta Rel"):
    r = client.post("/instruments", json={"name": f"Unit {serial}", "model": model, "serial_number": serial, "manufacturer": "BD"})
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["id"])


def _template(client, model, report_type="repair"):
    r = client.post(
        "/report-templates",
        json={"instrument_type": "flow_cytometer", "report_type": report_type, "model": model, "fields": [{"name": "summary", "type": "text"}]},
    )
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["id"])


def _report(db, unit, template, day, *, fault=None, labor=None, parts=(), status=models.ReportStatus.finalized):
    fields: dict = {}
    if fault:
        fields["fault_category"] = fault
    if labor is not None:
        fields["labor_hours"] = labor
    if parts:
        fields["components_replaced"] = [{"part_name": n, "part_number": None, "qty": q} for n, q in parts]
    db.add(models.Report(instrument_id=unit, template_id=template, status=status, report_date=day, extracted_fields=fields))
    db.commit()


def _model_id(client, name):
    return next(m for m in client.get("/instrument-models").json() if m["name"] == name)["id"]


def _get(client, name):
    r = client.get(f"/instrument-models/{_model_id(client, name)}/reliability")
    assert r.status_code == 200, r.text
    return r.json()


def test_unknown_model_is_404(client):
    assert client.get(f"/instrument-models/{uuid.uuid4()}/reliability").status_code == 404


def test_too_few_repairs_gives_counts_without_averages(client, db_session):
    a = _unit(client, "R1", "Zeta Few")
    t = _template(client, "Zeta Few")
    _report(db_session, a, t, date(2026, 1, 1), fault="Fluidics", labor=2)
    _report(db_session, a, t, date(2026, 3, 1), fault="Fluidics", labor=4)
    out = _get(client, "Zeta Few")
    assert out["repair_count"] == 2 and out["enough_data"] is False and out["min_repairs"] == 3
    assert out["mean_days_between_repairs"] is None and out["avg_labor_hours"] is None
    assert out["units"][0]["mean_days_between_repairs"] is None and out["units"][0]["repair_count"] == 2
    assert out["fault_categories"][0]["category"] == "Fluidics" and out["fault_categories"][0]["report_count"] == 2
    assert out["total_labor_hours"] == 6


def test_gaps_labor_and_faults_with_enough_repairs(client, db_session):
    a = _unit(client, "R2", "Zeta Many")
    b = _unit(client, "R3", "Zeta Many")
    t = _template(client, "Zeta Many")
    _report(db_session, a, t, date(2026, 1, 1), fault="Fluidics", labor=2, parts=[("Lens", 1)])
    _report(db_session, a, t, date(2026, 1, 11), fault="Fluidics", labor=4, parts=[("Lens", 2), ("Seal", 1)])
    _report(db_session, a, t, date(2026, 1, 31), fault="Laser", labor=6)
    _report(db_session, b, t, date(2026, 2, 1), fault="Laser", labor=None)
    _report(db_session, b, t, None)  # undated: out of the gaps
    _report(db_session, b, t, date(2026, 3, 1), status=models.ReportStatus.draft)  # draft: ignored
    out = _get(client, "Zeta Many")
    assert out["repair_count"] == 5 and out["enough_data"] is True
    units = {u["serial_number"]: u for u in out["units"]}
    assert units["R2"]["mean_days_between_repairs"] == 15  # gaps 10 and 20
    assert units["R3"]["mean_days_between_repairs"] is None  # one dated repair
    assert out["mean_days_between_repairs"] == 15 and out["gap_count"] == 2
    assert out["repairs_without_date"] == 1
    assert out["avg_labor_hours"] == 4 and out["repairs_with_labor_hours"] == 3
    faults = {f["category"]: f for f in out["fault_categories"]}
    assert faults["Fluidics"]["report_count"] == 2 and faults["Fluidics"]["repeat"] is True
    assert faults["Laser"]["report_count"] == 2 and faults["Laser"]["instrument_count"] == 2 and faults["Laser"]["repeat"] is False
    assert out["repairs_with_fault_category"] == 4
    parts = {p["part_name"]: p for p in out["parts"]}
    assert parts["Lens"]["total_qty"] == 3 and parts["Lens"]["times_replaced"] == 2 and parts["Seal"]["total_qty"] == 1


def test_only_this_models_repairs_count(client, db_session):
    a = _unit(client, "R4", "Zeta Mine")
    other = _unit(client, "R5", "Zeta Other")
    t = _template(client, "Zeta Mine")
    pm = _template(client, "Zeta Mine", "preventive_maintenance")
    t2 = _template(client, "Zeta Other")
    _report(db_session, a, t, date(2026, 1, 1))
    _report(db_session, a, pm, date(2026, 2, 1))  # maintenance, not a repair
    _report(db_session, other, t2, date(2026, 1, 5))
    out = _get(client, "Zeta Mine")
    assert out["repair_count"] == 1 and [u["serial_number"] for u in out["units"]] == ["R4"]


def test_model_with_no_instruments(client):
    r = client.post("/instrument-models", json={"name": "Zeta Empty"})
    assert r.status_code == 201
    out = client.get(f"/instrument-models/{r.json()['id']}/reliability").json()
    assert out["repair_count"] == 0 and out["units"] == [] and out["fault_categories"] == [] and out["parts"] == []


def test_fleet_analytics_model_filter(client, db_session):
    from app.services.analytics import AnalyticsFilters, compute_fleet_analytics

    a = _unit(client, "R6", "Zeta Filt")
    b = _unit(client, "R7", "Zeta Filt Two")
    t = _template(client, "Zeta Filt")
    t2 = _template(client, "Zeta Filt Two")
    _report(db_session, a, t, date(2026, 1, 1), labor=3)
    _report(db_session, b, t2, date(2026, 1, 1), labor=9)
    out = compute_fleet_analytics(db_session, AnalyticsFilters(model_id=uuid.UUID(_model_id(client, "Zeta Filt"))))
    assert out.finalized_report_count == 1 and out.total_labor_hours == 3
    assert [r.serial_number for r in out.labor_hours_by_instrument] == ["R6"]
