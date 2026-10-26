"""Step 1 of the models plan: every instrument is linked to a record named by
its exact model text, on every write path, and nothing is merged."""
from __future__ import annotations

from app import models
from app.services.instrument_models import near_duplicates


def _payload(serial: str, model: str = "ZetaSorter III", **extra):
    return {"name": f"Unit {serial}", "model": model, "serial_number": serial, "manufacturer": "BD", **extra}


def _records(db_session):
    """The records these tests made (the seeded fleet has its own)."""
    return {m.name: m for m in db_session.query(models.InstrumentModel).all() if "Zeta" in m.name or m.name == "Tecnai X"}


def _mine(db_session):
    return db_session.query(models.Instrument).filter(models.Instrument.serial_number.like("S%")).all()


def test_creating_an_instrument_creates_and_links_its_model(client, db_session):
    r = client.post("/instruments", json=_payload("S1", manufacturer="BD", instrument_type="facs"))
    assert r.status_code == 201
    records = _records(db_session)
    assert set(records) == {"ZetaSorter III"}
    assert records["ZetaSorter III"].manufacturer == "BD"
    assert records["ZetaSorter III"].instrument_type == "facs"
    instrument = _mine(db_session)[0]
    assert instrument.model_id == records["ZetaSorter III"].id


def test_units_of_one_model_share_one_record(client, db_session):
    client.post("/instruments", json=_payload("S1"))
    client.post("/instruments", json=_payload("S2"))
    records = _records(db_session)
    assert len(records) == 1
    assert {i.model_id for i in _mine(db_session)} == {records["ZetaSorter III"].id}


def test_near_duplicate_names_stay_separate_records(client, db_session):
    client.post("/instruments", json=_payload("S1", model="ZetaSorter III"))
    client.post("/instruments", json=_payload("S2", model="Zeta Sorter III"))
    assert set(_records(db_session)) == {"ZetaSorter III", "Zeta Sorter III"}


def test_editing_the_model_text_relinks_and_keeps_the_old_record(client, db_session):
    created = client.post("/instruments", json=_payload("S1")).json()
    r = client.patch(f"/instruments/{created['id']}", json={"model": "ZetaSorter Fusion"})
    assert r.status_code == 200
    db_session.expire_all()
    records = _records(db_session)
    assert set(records) == {"ZetaSorter III", "ZetaSorter Fusion"}
    assert _mine(db_session)[0].model_id == records["ZetaSorter Fusion"].id


def test_editing_other_fields_keeps_the_link(client, db_session):
    created = client.post("/instruments", json=_payload("S1")).json()
    before = _mine(db_session)[0].model_id
    client.patch(f"/instruments/{created['id']}", json={"institution": "Bar-Ilan University"})
    db_session.expire_all()
    assert _mine(db_session)[0].model_id == before
    assert len(_records(db_session)) == 1


def test_instruments_built_directly_are_linked_too(db_session):
    # Seeds and older tests create rows without going through the API.
    db_session.add_all(
        [
            models.Instrument(name="A", model="Tecnai X", serial_number="D1", instrument_type="facs"),
            models.Instrument(name="B", model="Tecnai X", serial_number="D2", instrument_type="facs"),
        ]
    )
    db_session.commit()
    assert len(_records(db_session)) == 1
    assert all(i.model_id for i in db_session.query(models.Instrument).all())


def test_seeded_fleet_is_linked(client, db_session):
    assert db_session.query(models.Instrument).filter(models.Instrument.model_id.is_(None)).count() == 0


def test_the_api_does_not_expose_the_link_yet(client):
    created = client.post("/instruments", json=_payload("S1")).json()
    assert "model_id" not in created and "model_record" not in created


def test_deleting_an_instrument_leaves_its_model_record(client, db_session):
    created = client.post("/instruments", json=_payload("S1")).json()
    assert client.delete(f"/instruments/{created['id']}").status_code == 204
    assert set(_records(db_session)) == {"ZetaSorter III"}


def test_near_duplicates_lists_similar_names_only():
    groups = near_duplicates(["FACSAria III", "FACS Aria III", "facsaria iii", "Tecnai", "LSRFortessa"])
    assert len(groups) == 1
    assert set(groups[0]) == {"FACSAria III", "FACS Aria III", "facsaria iii"}
    assert near_duplicates(["Tecnai", "LSRFortessa", "FACSCanto II"]) == []
