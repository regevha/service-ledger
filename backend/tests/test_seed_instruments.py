"""The seeded fleet uses invented serial numbers, and a database seeded
with the earlier ones is migrated in place rather than gaining a second
unit of each model (which would stop documents being assigned by model alone)."""
from __future__ import annotations

import hashlib

from app import models, seed_instruments
from app.models import Instrument

REAL = {
    "FACSAria III": "P900001A0003",
    "LSRFortessa": "R900002A0092",
    "FACSDiscover S8": "MP9000030000057",
    "Cytek Aurora": "Y9004",
    "CytoFLEX S": "900005",
}


def _fleet(db):
    return {i.model: i.serial_number for i in db.query(Instrument).all()}


def test_a_fresh_database_gets_the_seed_serials(db_session):
    seed_instruments.seed(db_session)
    assert _fleet(db_session) == REAL


def test_seeding_twice_changes_nothing(db_session):
    seed_instruments.seed(db_session)
    ids = {i.serial_number: i.id for i in db_session.query(Instrument).all()}
    seed_instruments.seed(db_session)
    assert {i.serial_number: i.id for i in db_session.query(Instrument).all()} == ids


def test_the_early_demo_serials_are_renamed_in_place_and_keep_their_reports(db_session):
    legacy = [
        Instrument(name="FACSAria III", model="FACSAria III", serial_number="A47291", instrument_type="flow_cytometer", status="active"),
        Instrument(name="FACSDiscover S8", model="FACSDiscover S8", serial_number="S80019", instrument_type="flow_cytometer", status="active"),
    ]
    db_session.add_all(legacy)
    db_session.flush()
    report = models.Report(instrument_id=legacy[0].id)
    db_session.add(report)
    db_session.commit()
    aria_id = legacy[0].id

    seed_instruments.seed(db_session)
    db_session.expire_all()

    assert _fleet(db_session) == REAL  # one unit per model, no leftovers
    assert db_session.get(Instrument, aria_id).serial_number == "P900001A0003"
    assert db_session.get(models.Report, report.id).instrument_id == aria_id


def test_a_real_unit_already_added_by_hand_is_not_merged_with_the_demo_row(db_session):
    db_session.add_all(
        [
            Instrument(name="Old", model="FACSAria III", serial_number="A47291", instrument_type="flow_cytometer", status="active"),
            Instrument(name="Mine", model="FACSAria III", serial_number="P900001A0003", instrument_type="flow_cytometer", status="active"),
        ]
    )
    db_session.commit()

    seed_instruments.seed(db_session)  # must not raise a unique-serial error

    serials = sorted(s for (s,) in db_session.query(Instrument.serial_number).filter(Instrument.model == "FACSAria III"))
    assert serials == ["A47291", "P900001A0003"]


def test_the_seeded_fleet_carries_its_makers(db_session):
    seed_instruments.seed(db_session)
    makers = {i.model: i.manufacturer for i in db_session.query(Instrument).all()}
    assert makers == {
        "FACSAria III": "BD",
        "LSRFortessa": "BD",
        "FACSDiscover S8": "BD",
        "Cytek Aurora": "Cytek Biosciences",
        "CytoFLEX S": "Beckman Coulter",
    }


def test_the_hebrew_form_instruments_are_seeded_with_their_distributors(db_session):
    seed_instruments.seed(db_session)
    rows = {i.serial_number: i for i in db_session.query(Instrument).all()}
    assert rows["Y9004"].distributor == "sigma diagnostics" and rows["Y9004"].instrument_type == "flow_cytometer"
    assert rows["900005"].distributor == "Omega Distribution" and rows["900005"].instrument_type == "flow_cytometer"
    assert rows["P900001A0003"].distributor is None


def test_seeding_fills_a_missing_distributor_but_keeps_one_a_person_set(db_session):
    seed_instruments.seed(db_session)
    rows = {i.serial_number: i for i in db_session.query(Instrument).all()}
    rows["Y9004"].distributor = None
    rows["900005"].distributor = "Someone else"
    db_session.commit()

    seed_instruments.seed(db_session)
    db_session.expire_all()
    rows = {i.serial_number: i for i in db_session.query(Instrument).all()}
    assert rows["Y9004"].distributor == "sigma diagnostics"
    assert rows["900005"].distributor == "Someone else"


def test_seeding_fills_a_missing_manufacturer_but_keeps_one_a_person_set(db_session):
    seed_instruments.seed(db_session)
    rows = {i.model: i for i in db_session.query(Instrument).all()}
    rows["LSRFortessa"].manufacturer = None
    rows["FACSAria III"].manufacturer = "Custom Maker"
    db_session.commit()

    seed_instruments.seed(db_session)
    db_session.expire_all()

    rows = {i.model: i for i in db_session.query(Instrument).all()}
    assert rows["LSRFortessa"].manufacturer == "BD"
    assert rows["FACSAria III"].manufacturer == "Custom Maker"


def test_a_database_seeded_with_replaced_serials_is_moved_in_place_and_keeps_its_reports(db_session, monkeypatch):
    # The repository keeps only hashes of the serials it replaced; the test uses a stand-in pair.
    old = "OLD-TEST-SERIAL-1"
    monkeypatch.setitem(
        seed_instruments.REPLACED_SERIAL_HASHES, hashlib.sha256(old.encode()).hexdigest(), "NEW-TEST-SERIAL-1"
    )
    unit = Instrument(name="Unit", model="FACSAria III", serial_number=old, instrument_type="flow_cytometer", status="active")
    db_session.add(unit)
    db_session.flush()
    report = models.Report(instrument_id=unit.id)
    db_session.add(report)
    db_session.commit()
    unit_id = unit.id

    seed_instruments.seed(db_session)
    db_session.expire_all()

    assert db_session.get(Instrument, unit_id).serial_number == "NEW-TEST-SERIAL-1"
    assert db_session.get(models.Report, report.id).instrument_id == unit_id
