"""Places plan step 3: the place filter (an institution, faculty or room, with
everything inside it) on the Reports list, its CSV export, the Analytics numbers
and saved filters, plus the per-place roll-ups."""
from __future__ import annotations

import uuid
from datetime import date

from app import models


def _unit(client, serial, institution=None, location=None):
    r = client.post(
        "/instruments",
        json={"name": f"Unit {serial}", "model": "Zeta Filt Model", "serial_number": serial, "manufacturer": "BD", "institution": institution, "location": location},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _template(client):
    r = client.post(
        "/report-templates",
        json={"instrument_type": "facs", "report_type": "repair", "model": "Zeta Filt Model", "fields": [{"name": "labor_hours", "type": "number"}]},
    )
    assert r.status_code in (201, 409), r.text
    return uuid.UUID(client.get("/report-templates", params={"report_type": "repair", "model": "Zeta Filt Model"}).json()[0]["id"])


def _report(db, unit, template, hours=1, day=date(2026, 5, 1)):
    db.add(
        models.Report(
            instrument_id=uuid.UUID(unit["id"]),
            template_id=template,
            status=models.ReportStatus.finalized,
            extracted_fields={"labor_hours": hours},
            report_date=day,
        )
    )
    db.commit()


def _place(client, kind, name, institution=None):
    rows = [p for p in client.get("/places").json() if p["kind"] == kind and p["name"] == name and (institution is None or p["institution_name"] == institution)]
    assert len(rows) == 1, rows
    return rows[0]


def _setup(client, db):
    t = _template(client)
    a = _unit(client, "F1", "Zeta Filter Uni", "Room A")
    b = _unit(client, "F2", "Zeta Filter Uni", "Room B")
    c = _unit(client, "F3", "Zeta Other Uni", "Room A")
    d = _unit(client, "F4")
    for unit, hours in ((a, 2), (a, 3), (b, 4), (c, 8), (d, 16)):
        _report(db, unit, t, hours)
    return a, b, c, d


def _serials(rows):
    return sorted(r["instrument_serial_number"] for r in rows)


def test_instrument_output_carries_its_place(client):
    a = _unit(client, "F5", "Zeta Filter Uni", "Room A")
    plain = _unit(client, "F6")
    assert a["place_id"] == _place(client, "room", "Room A", "Zeta Filter Uni")["id"]
    assert plain["place_id"] is None


def test_reports_list_filters_by_institution_and_by_room(client, db_session):
    _setup(client, db_session)
    uni = _place(client, "institution", "Zeta Filter Uni")
    room = _place(client, "room", "Room A", "Zeta Filter Uni")
    mine = lambda rows: [r for r in rows if r["instrument_serial_number"] in ("F1", "F2", "F3", "F4")]  # noqa: E731
    assert _serials(mine(client.get("/reports", params={"place_id": uni["id"]}).json())) == ["F1", "F1", "F2"]
    assert _serials(mine(client.get("/reports", params={"place_id": room["id"]}).json())) == ["F1", "F1"]


def test_filter_by_faculty_includes_its_rooms(client, db_session):
    _setup(client, db_session)
    uni = _place(client, "institution", "Zeta Filter Uni")
    fac = client.post("/places", json={"kind": "faculty", "name": "Zeta Faculty", "parent_id": uni["id"]}).json()
    room_b = _place(client, "room", "Room B", "Zeta Filter Uni")
    client.patch(f"/places/{room_b['id']}", json={"parent_id": fac["id"]})
    rows = client.get("/reports", params={"place_id": fac["id"]}).json()
    assert _serials(rows) == ["F2"]
    rows = client.get("/reports", params={"place_id": uni["id"]}).json()
    assert "F2" in _serials(rows)  # the institution still includes it


def test_unknown_place_matches_nothing(client, db_session):
    _setup(client, db_session)
    assert client.get("/reports", params={"place_id": str(uuid.uuid4())}).json() == []


def test_csv_export_uses_the_same_place_filter(client, db_session):
    _setup(client, db_session)
    room = _place(client, "room", "Room A", "Zeta Filter Uni")
    text = client.get("/reports/export", params={"place_id": room["id"]}).text
    assert text.count("F1") == 2 and "F2" not in text and "F3" not in text


def test_analytics_filter_narrows_numbers_and_units(client, db_session):
    _setup(client, db_session)
    uni = _place(client, "institution", "Zeta Filter Uni")
    out = client.get("/analytics/fleet", params={"place_id": uni["id"]}).json()
    assert out["finalized_report_count"] == 3 and out["total_labor_hours"] == 9
    assert sorted(r["serial_number"] for r in out["report_counts_by_instrument"]) == ["F1", "F2"]


def test_place_rollups_per_level(client, db_session):
    _setup(client, db_session)
    out = client.get("/analytics/fleet").json()["place_rollups"]
    by = {(r["kind"], r["name"], r["institution_name"]): r for r in out}
    uni = by[("institution", "Zeta Filter Uni", "Zeta Filter Uni")]
    assert (uni["instrument_count"], uni["report_count"], uni["total_labor_hours"]) == (2, 3, 9)
    room_a = by[("room", "Room A", "Zeta Filter Uni")]
    assert (room_a["instrument_count"], room_a["report_count"], room_a["total_labor_hours"]) == (1, 2, 5)
    other = by[("institution", "Zeta Other Uni", "Zeta Other Uni")]
    assert (other["instrument_count"], other["report_count"]) == (1, 1)


def test_rollups_include_a_faculty_level(client, db_session):
    _setup(client, db_session)
    uni = _place(client, "institution", "Zeta Filter Uni")
    fac = client.post("/places", json={"kind": "faculty", "name": "Zeta Faculty", "parent_id": uni["id"]}).json()
    client.patch(f"/places/{_place(client, 'room', 'Room A', 'Zeta Filter Uni')['id']}", json={"parent_id": fac["id"]})
    out = client.get("/analytics/fleet").json()["place_rollups"]
    f = next(r for r in out if r["kind"] == "faculty" and r["name"] == "Zeta Faculty")
    assert (f["instrument_count"], f["report_count"], f["total_labor_hours"]) == (1, 2, 5)
    assert f["institution_name"] == "Zeta Filter Uni"


def test_saved_filter_keeps_a_place_and_flags_it_when_deleted(client):
    _unit(client, "F7", "Zeta Saved Uni", None)
    uni = _place(client, "institution", "Zeta Saved Uni")
    made = client.post("/saved-report-filters", json={"name": "Zeta place", "filters": {"place_id": uni["id"]}})
    assert made.status_code == 201 and made.json()["filters"] == {"place_id": uni["id"]}
    assert made.json()["stale"] is False
    bad = client.post("/saved-report-filters", json={"name": "Zeta bad", "filters": {"place_id": str(uuid.uuid4())}})
    assert bad.status_code == 422
    # make the place disappear: move the only instrument away then delete it
    inst = next(i for i in client.get("/instruments").json() if i["serial_number"] == "F7")
    client.patch(f"/instruments/{inst['id']}", json={"institution": None})
    assert client.delete(f"/places/{uni['id']}").status_code == 204
    listed = next(i for i in client.get("/saved-report-filters").json()["items"] if i["name"] == "Zeta place")
    assert listed["stale"] is True and listed["stale_keys"] == ["place_id"]
    client.delete(f"/saved-report-filters/{listed['id']}")
