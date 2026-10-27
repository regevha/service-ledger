"""Places plan step 2: the place record is the source. Edits follow through to the
instruments' text; merging and deleting say what moves or refuses."""
from __future__ import annotations

from app import models


def _unit(client, serial, institution="Zeta Univ", location="Room 1"):
    r = client.post(
        "/instruments",
        json={"name": f"Unit {serial}", "model": "Zeta M", "serial_number": serial, "manufacturer": "BD", "institution": institution, "location": location},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _places(client):
    return client.get("/places").json()


def _find(client, kind, name, institution=None):
    rows = [p for p in _places(client) if p["kind"] == kind and p["name"] == name and (institution is None or p["institution_name"] == institution)]
    assert len(rows) == 1, rows
    return rows[0]


def _inst(client, serial):
    return next(i for i in client.get("/instruments").json() if i["serial_number"] == serial)


def test_list_counts_and_hierarchy(client):
    _unit(client, "Q1")
    _unit(client, "Q2")
    _unit(client, "Q3", location=None)
    uni = _find(client, "institution", "Zeta Univ")
    room = _find(client, "room", "Room 1")
    assert (room["unit_count"], room["total_unit_count"]) == (2, 2)
    assert (uni["unit_count"], uni["total_unit_count"], uni["child_count"]) == (1, 3, 1)
    assert room["institution_name"] == "Zeta Univ" and room["faculty_id"] is None


def test_create_validates_kind_and_parent(client):
    uni = client.post("/places", json={"kind": "institution", "name": " Zeta   College "}).json()
    assert uni["name"] == "Zeta College"
    assert client.post("/places", json={"kind": "institution", "name": "zeta college"}).status_code == 409
    assert client.post("/places", json={"kind": "institution", "name": "X", "parent_id": uni["id"]}).status_code == 422
    assert client.post("/places", json={"kind": "faculty", "name": "Physics"}).status_code == 422
    fac = client.post("/places", json={"kind": "faculty", "name": "Physics", "parent_id": uni["id"]})
    assert fac.status_code == 201 and fac.json()["institution_name"] == "Zeta College"
    assert client.post("/places", json={"kind": "faculty", "name": "Chem", "parent_id": fac.json()["id"]}).status_code == 422
    room = client.post("/places", json={"kind": "room", "name": "B12", "parent_id": fac.json()["id"]})
    assert room.status_code == 201 and room.json()["faculty_name"] == "Physics"
    assert client.post("/places", json={"kind": "room", "name": "b12", "parent_id": fac.json()["id"]}).status_code == 409
    # the same room name elsewhere is fine
    assert client.post("/places", json={"kind": "room", "name": "B12", "parent_id": uni["id"]}).status_code == 201
    assert client.post("/places", json={"kind": "room", "name": "   ", "parent_id": uni["id"]}).status_code == 422


def test_renaming_a_room_updates_the_instruments_text(client):
    _unit(client, "Q4")
    room = _find(client, "room", "Room 1")
    r = client.patch(f"/places/{room['id']}", json={"name": "Room 101"})
    assert r.status_code == 200 and r.json()["name"] == "Room 101"
    inst = _inst(client, "Q4")
    assert inst["location"] == "Room 101" and inst["institution"] == "Zeta Univ"
    # still linked: saving the instrument again does not create a second room
    client.patch(f"/instruments/{inst['id']}", json={"name": "Renamed"})
    assert len([p for p in _places(client) if p["kind"] == "room" and p["institution_name"] == "Zeta Univ"]) == 1


def test_renaming_an_institution_updates_every_instrument_inside(client):
    _unit(client, "Q5")
    _unit(client, "Q6", location=None)
    uni = _find(client, "institution", "Zeta Univ")
    assert client.patch(f"/places/{uni['id']}", json={"name": "Zeta University"}).status_code == 200
    assert {_inst(client, s)["institution"] for s in ("Q5", "Q6")} == {"Zeta University"}
    assert _inst(client, "Q5")["location"] == "Room 1"


def test_rename_clash_is_refused(client):
    _unit(client, "Q7", location="A1")
    _unit(client, "Q8", location="A2")
    room = _find(client, "room", "A2")
    r = client.patch(f"/places/{room['id']}", json={"name": "a1"})
    assert r.status_code == 409 and "A1" in r.json()["detail"] or "a1" in r.json()["detail"]


def test_moving_a_room_into_a_faculty_keeps_the_text(client):
    _unit(client, "Q9", location="C3")
    uni = _find(client, "institution", "Zeta Univ")
    fac = client.post("/places", json={"kind": "faculty", "name": "Life Sci", "parent_id": uni["id"]}).json()
    room = _find(client, "room", "C3")
    r = client.patch(f"/places/{room['id']}", json={"parent_id": fac["id"]})
    assert r.status_code == 200 and r.json()["faculty_name"] == "Life Sci"
    inst = _inst(client, "Q9")
    assert (inst["institution"], inst["location"]) == ("Zeta Univ", "C3")


def test_moving_a_room_to_another_institution_changes_the_instruments_institution(client):
    _unit(client, "Q10", institution="Zeta One", location="D4")
    other = client.post("/places", json={"kind": "institution", "name": "Zeta Two"}).json()
    room = _find(client, "room", "D4")
    assert client.patch(f"/places/{room['id']}", json={"parent_id": other["id"]}).status_code == 200
    assert _inst(client, "Q10")["institution"] == "Zeta Two"


def test_delete_refuses_places_in_use_and_says_what(client):
    _unit(client, "Q11", location="E5")
    uni = _find(client, "institution", "Zeta Univ")
    room = _find(client, "room", "E5")
    inside = client.delete(f"/places/{uni['id']}")
    assert inside.status_code == 409 and "inside" in inside.json()["detail"]
    used = client.delete(f"/places/{room['id']}")
    assert used.status_code == 409 and "1 instrument" in used.json()["detail"]
    empty = client.post("/places", json={"kind": "room", "name": "Unused", "parent_id": uni["id"]}).json()
    assert client.delete(f"/places/{empty['id']}").status_code == 204
    assert client.delete(f"/places/{empty['id']}").status_code == 404


def test_merge_rooms_moves_instruments_and_updates_text(client):
    _unit(client, "Q12", location="Room 205")
    _unit(client, "Q13", location="205")
    a, b = _find(client, "room", "Room 205", "Zeta Univ"), _find(client, "room", "205", "Zeta Univ")
    r = client.post(f"/places/{b['id']}/merge", json={"into_id": a["id"]})
    assert r.status_code == 200 and r.json() == {"moved_instruments": 1, "moved_places": 0, "into": "Room 205"}
    assert _inst(client, "Q13")["location"] == "Room 205"
    assert not [p for p in _places(client) if p["id"] == b["id"]]
    assert _find(client, "room", "Room 205", "Zeta Univ")["unit_count"] == 2


def test_merge_institutions_moves_rooms_and_updates_instruments(client):
    _unit(client, "Q14", institution="Zeta Bar Ilan", location="R1")
    _unit(client, "Q15", institution="Zeta Bar-Ilan University", location="R2")
    a, b = _find(client, "institution", "Zeta Bar-Ilan University"), _find(client, "institution", "Zeta Bar Ilan")
    r = client.post(f"/places/{b['id']}/merge", json={"into_id": a["id"]})
    assert r.status_code == 200 and r.json()["moved_places"] == 1
    inst = _inst(client, "Q14")
    assert (inst["institution"], inst["location"]) == ("Zeta Bar-Ilan University", "R1")


def test_merge_refuses_same_named_children_and_other_kinds(client):
    _unit(client, "Q16", institution="Zeta A", location="Lab")
    _unit(client, "Q17", institution="Zeta B", location="Lab")
    a, b = _find(client, "institution", "Zeta A"), _find(client, "institution", "Zeta B")
    clash = client.post(f"/places/{a['id']}/merge", json={"into_id": b["id"]})
    assert clash.status_code == 409 and "Lab" in clash.json()["detail"]
    room = _find(client, "room", "Lab", "Zeta A")
    assert client.post(f"/places/{room['id']}/merge", json={"into_id": b["id"]}).status_code == 422
    assert client.post(f"/places/{a['id']}/merge", json={"into_id": a["id"]}).status_code == 422


def test_similar_names_are_listed_not_merged(client):
    _unit(client, "Q18", location="Room 305")
    _unit(client, "Q19", location="305")
    row = _find(client, "room", "305")
    assert row["similar_to"] == ["Room 305"]
