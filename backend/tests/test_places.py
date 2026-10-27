"""Step 1 of the places plan: every instrument that names a place is linked to a
place record on every write path, and nothing is merged."""
from __future__ import annotations

from app import models
from app.services.places import clean, text_of


def _payload(serial: str, **extra):
    return {"name": f"Unit {serial}", "model": "Zeta Place Model", "serial_number": serial, "manufacturer": "BD", **extra}


def _mine(db_session, serial):
    db_session.expire_all()
    return db_session.query(models.Instrument).filter(models.Instrument.serial_number == serial).one()


def _places(db_session, institution_like="Zeta"):
    db_session.expire_all()
    return [p for p in db_session.query(models.Place).all() if institution_like in (text_of(p)[0] or "")]


def test_clean_collapses_spaces_and_blanks():
    assert clean("  Room   205 ") == "Room 205" and clean("   ") is None and clean(None) is None


def test_room_and_institution_create_a_room_under_the_institution(client, db_session):
    assert client.post("/instruments", json=_payload("P1", institution="Zeta University", location="Room 205")).status_code == 201
    unit = _mine(db_session, "P1")
    assert unit.place.kind == "room" and unit.place.name == "Room 205"
    assert unit.place.parent.kind == "institution" and unit.place.parent.name == "Zeta University"
    assert unit.institution == "Zeta University" and unit.location == "Room 205"  # the text stays the source


def test_institution_alone_links_to_the_institution(client, db_session):
    client.post("/instruments", json=_payload("P2", institution="Zeta University"))
    unit = _mine(db_session, "P2")
    assert unit.place.kind == "institution" and unit.place.name == "Zeta University"


def test_room_without_institution_stays_unlinked(client, db_session):
    client.post("/instruments", json=_payload("P3", location="Core Lab"))
    assert _mine(db_session, "P3").place_id is None


def test_no_place_text_means_no_link(client, db_session):
    client.post("/instruments", json=_payload("P4"))
    assert _mine(db_session, "P4").place_id is None


def test_same_place_typed_with_other_case_or_spacing_is_one_record(client, db_session):
    client.post("/instruments", json=_payload("P5", institution="Zeta University", location="Room 205"))
    client.post("/instruments", json=_payload("P6", institution="  zeta   university ", location="room 205"))
    a, b = _mine(db_session, "P5"), _mine(db_session, "P6")
    assert a.place_id == b.place_id
    assert len([p for p in _places(db_session) if p.kind == "institution"]) == 1


def test_different_spellings_stay_separate_places(client, db_session):
    client.post("/instruments", json=_payload("P7", institution="Zeta University", location="Room 205"))
    client.post("/instruments", json=_payload("P8", institution="Zeta University", location="205"))
    assert _mine(db_session, "P7").place_id != _mine(db_session, "P8").place_id


def test_same_room_name_in_two_institutions_is_two_rooms(client, db_session):
    client.post("/instruments", json=_payload("P9", institution="Zeta University", location="Room 1"))
    client.post("/instruments", json=_payload("P10", institution="Zeta Institute", location="Room 1"))
    assert _mine(db_session, "P9").place_id != _mine(db_session, "P10").place_id


def test_editing_the_text_relinks_and_keeps_the_old_place(client, db_session):
    created = client.post("/instruments", json=_payload("P11", institution="Zeta University", location="Room 1")).json()
    r = client.patch(f"/instruments/{created['id']}", json={"location": "Room 2"})
    assert r.status_code == 200
    unit = _mine(db_session, "P11")
    assert unit.place.name == "Room 2" and unit.place.parent.name == "Zeta University"
    rooms = {p.name for p in _places(db_session) if p.kind == "room"}
    assert rooms == {"Room 1", "Room 2"}


def test_clearing_the_text_clears_the_link(client, db_session):
    created = client.post("/instruments", json=_payload("P12", institution="Zeta University", location="Room 1")).json()
    client.patch(f"/instruments/{created['id']}", json={"institution": None, "location": None})
    assert _mine(db_session, "P12").place_id is None


def test_editing_other_fields_keeps_the_link(client, db_session):
    created = client.post("/instruments", json=_payload("P13", institution="Zeta University", location="Room 1")).json()
    before = _mine(db_session, "P13").place_id
    client.patch(f"/instruments/{created['id']}", json={"name": "Renamed"})
    assert _mine(db_session, "P13").place_id == before


def test_an_existing_room_in_a_faculty_is_reused_not_duplicated(client, db_session):
    institution = models.Place(kind="institution", name="Zeta College")
    faculty = models.Place(kind="faculty", name="Life Sciences", parent=institution)
    room = models.Place(kind="room", name="B12", parent=faculty)
    db_session.add_all([institution, faculty, room])
    db_session.commit()
    client.post("/instruments", json=_payload("P14", institution="Zeta College", location="B12"))
    unit = _mine(db_session, "P14")
    assert unit.place_id == room.id
    assert len([p for p in db_session.query(models.Place).filter(models.Place.name == "B12")]) == 1


def test_a_room_name_in_two_faculties_is_ambiguous_so_not_linked(client, db_session):
    institution = models.Place(kind="institution", name="Zeta Tech")
    f1 = models.Place(kind="faculty", name="Physics", parent=institution)
    f2 = models.Place(kind="faculty", name="Chemistry", parent=institution)
    db_session.add_all([institution, f1, f2, models.Place(kind="room", name="101", parent=f1), models.Place(kind="room", name="101", parent=f2)])
    db_session.commit()
    client.post("/instruments", json=_payload("P15", institution="Zeta Tech", location="101"))
    assert _mine(db_session, "P15").place_id is None


def test_text_of_walks_up_the_tree():
    institution = models.Place(kind="institution", name="U")
    faculty = models.Place(kind="faculty", name="F", parent=institution)
    room = models.Place(kind="room", name="R", parent=faculty)
    assert text_of(room) == ("U", "R") and text_of(faculty) == ("U", None) and text_of(institution) == ("U", None)
    assert text_of(None) == (None, None)


def test_places_near_duplicates_include_names_inside_each_other():
    from app.services.instrument_models import near_duplicates

    assert near_duplicates(["Room 205", "205", "C767"], contains=True) == [["205", "Room 205"]]
    assert near_duplicates(["Bar Ilan", "Bar-Ilan University", "MIT"], contains=True) == [["Bar Ilan", "Bar-Ilan University"]]
    assert near_duplicates(["Room 205", "205"]) == []  # models keep the stricter rule
