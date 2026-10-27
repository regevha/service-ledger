"""Models plan step 4, part A: overdue maintenance state and the manufacturer lock."""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest

from app import models
from app.services.maintenance import add_months, state_for

TODAY = date(2026, 10, 27)


def test_add_months_clamps_to_month_end():
    assert add_months(date(2026, 1, 31), 1) == date(2026, 2, 28)
    assert add_months(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert add_months(date(2026, 11, 15), 3) == date(2027, 2, 15)
    assert add_months(date(2026, 3, 10), 12) == date(2027, 3, 10)


@pytest.mark.parametrize(
    "interval,last,state,due",
    [
        (None, date(2026, 1, 1), "not_tracked", None),
        (None, None, "not_tracked", None),
        (6, None, "no_record", None),
        (6, date(2026, 8, 27), "ok", date(2027, 2, 27)),
        (6, date(2026, 4, 27), "due_soon", date(2026, 10, 27)),  # due today: not yet overdue
        (6, date(2026, 4, 28), "due_soon", date(2026, 10, 28)),
        (6, date(2026, 3, 28), "overdue", date(2026, 9, 28)),
    ],
)
def test_state_for(interval, last, state, due):
    got_due, got_state = state_for(interval, last, TODAY)
    assert got_state == state
    assert got_due == due


def test_due_soon_window_is_30_days():
    # due 2026-11-26 is 30 days away -> due soon; 2026-11-27 is 31 -> ok
    assert state_for(6, date(2026, 5, 26), TODAY) == (date(2026, 11, 26), "due_soon")
    assert state_for(6, date(2026, 5, 27), TODAY) == (date(2026, 11, 27), "ok")


def _unit(client, serial, model="Zeta Pump", manufacturer="BD", **extra):
    r = client.post(
        "/instruments",
        json={"name": f"Unit {serial}", "model": model, "serial_number": serial, "manufacturer": manufacturer, **extra},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _set_interval(client, model, months):
    m = next(m for m in client.get("/instrument-models").json() if m["name"] == model)
    r = client.patch(f"/instrument-models/{m['id']}", json={"service_interval_months": months})
    assert r.status_code == 200, r.text
    return m


def _template(client, model, report_type):
    r = client.post(
        "/report-templates",
        json={"instrument_type": "facs", "report_type": report_type, "model": model, "fields": [{"name": "summary", "type": "text"}]},
    )
    assert r.status_code == 201, r.text
    return uuid.UUID(r.json()["id"])


def _report(db, unit_id, template_id, day, status=models.ReportStatus.finalized):
    db.add(models.Report(instrument_id=uuid.UUID(unit_id), template_id=template_id, status=status, report_date=day))
    db.commit()


def _get(client, unit):
    return client.get(f"/instruments/{unit['id']}").json()


def test_not_tracked_without_interval(client):
    u = _unit(client, "M1", model="Zeta Pump")
    assert _get(client, u)["maintenance_state"] == "not_tracked"


def test_no_record_then_ok_then_overdue(client, db_session):
    u = _unit(client, "M2", model="Zeta Valve")
    _set_interval(client, "Zeta Valve", 6)
    assert _get(client, u)["maintenance_state"] == "no_record"
    pm = _template(client, "Zeta Valve", "preventive_maintenance")
    today = date.today()
    _report(db_session, u["id"], pm, today - timedelta(days=30))
    got = _get(client, u)
    assert got["maintenance_state"] == "ok" and got["last_maintenance_date"] == str(today - timedelta(days=30))
    _report(db_session, u["id"], pm, today - timedelta(days=400))  # older: ignored
    assert _get(client, u)["last_maintenance_date"] == str(today - timedelta(days=30))


def test_overdue_and_due_soon_from_old_reports(client, db_session):
    a = _unit(client, "M3", model="Zeta Gear")
    b = _unit(client, "M4", model="Zeta Gear")
    _set_interval(client, "Zeta Gear", 6)
    pm = _template(client, "Zeta Gear", "preventive_maintenance")
    today = date.today()
    _report(db_session, a["id"], pm, add_months(today, -7))
    _report(db_session, b["id"], pm, add_months(today, -6) + timedelta(days=10))
    assert _get(client, a)["maintenance_state"] == "overdue"
    assert _get(client, b)["maintenance_state"] == "due_soon"
    states = {i["serial_number"]: i["maintenance_state"] for i in client.get("/instruments").json()}
    assert states["M3"] == "overdue" and states["M4"] == "due_soon"


def test_only_finalized_preventive_reports_count(client, db_session):
    u = _unit(client, "M5", model="Zeta Belt")
    _set_interval(client, "Zeta Belt", 6)
    pm = _template(client, "Zeta Belt", "preventive_maintenance")
    repair = _template(client, "Zeta Belt", "repair")
    today = date.today()
    _report(db_session, u["id"], pm, today, status=models.ReportStatus.draft)
    _report(db_session, u["id"], repair, today)
    assert _get(client, u)["maintenance_state"] == "no_record"


def test_undated_report_uses_creation_day(client, db_session):
    u = _unit(client, "M6", model="Zeta Cam")
    _set_interval(client, "Zeta Cam", 6)
    pm = _template(client, "Zeta Cam", "preventive_maintenance")
    _report(db_session, u["id"], pm, None)
    got = _get(client, u)
    assert got["last_maintenance_date"] == str(date.today()) and got["maintenance_state"] == "ok"


def test_retired_has_no_state(client):
    u = _unit(client, "M7", model="Zeta Fan")
    client.patch(f"/instruments/{u['id']}", json={"status": "retired"})
    assert _get(client, u)["maintenance_state"] is None


def test_maintenance_status_still_has_state(client):
    u = _unit(client, "M8", model="Zeta Fan2")
    _set_interval(client, "Zeta Fan2", 6)
    client.patch(f"/instruments/{u['id']}", json={"status": "maintenance"})
    assert _get(client, u)["maintenance_state"] == "no_record"


def test_model_page_units_carry_state(client, db_session):
    u = _unit(client, "M9", model="Zeta Lens")
    m = _set_interval(client, "Zeta Lens", 6)
    page = client.get(f"/instrument-models/{m['id']}").json()
    assert page["units"][0]["maintenance_state"] == "no_record" and page["units"][0]["maintenance_due_date"] is None


# ---- manufacturer lock ----

def test_manufacturer_follows_existing_model_on_create(client):
    _unit(client, "L1", model="Zeta Lock", manufacturer="BD")
    second = _unit(client, "L2", model="Zeta Lock", manufacturer="Someone Else")
    assert second["manufacturer"] == "BD"


def test_manufacturer_edit_on_instrument_is_ignored(client):
    u = _unit(client, "L3", model="Zeta Lock2", manufacturer="BD")
    r = client.patch(f"/instruments/{u['id']}", json={"manufacturer": "Other"})
    assert r.status_code == 200 and r.json()["manufacturer"] == "BD"


def test_switching_model_takes_the_new_models_manufacturer(client):
    _unit(client, "L4", model="Zeta LockA", manufacturer="Alpha")
    u = _unit(client, "L5", model="Zeta LockB", manufacturer="Beta")
    r = client.patch(f"/instruments/{u['id']}", json={"model": "Zeta LockA"})
    assert r.json()["manufacturer"] == "Alpha"


def test_model_without_manufacturer_adopts_the_first_one_given(client):
    r = client.post("/instrument-models", json={"name": "Zeta Blank"})
    assert r.status_code == 201
    u = _unit(client, "L6", model="Zeta Blank", manufacturer="Gamma")
    assert u["manufacturer"] == "Gamma"
    m = next(m for m in client.get("/instrument-models").json() if m["name"] == "Zeta Blank")
    assert m["manufacturer"] == "Gamma"
