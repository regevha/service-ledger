"""The seeded fleet uses the lab's real serial numbers, and a database seeded
with the early made-up ones is migrated in place rather than gaining a second
unit of each model (which would stop documents being assigned by model alone)."""
from __future__ import annotations

from app import models, seed_instruments
from app.models import Instrument

REAL = {
    "FACSAria III": "P648282B3003",
    "LSRFortessa": "R647794E6092",
    "FACSDiscover S8": "MP6651580000057",
    "Cytek Aurora": "Y1033",
    "CytoFLEX S": "102579",
}


def _fleet(db):
    return {i.model: i.serial_number for i in db.query(Instrument).all()}


def test_a_fresh_database_gets_the_real_serials(db_session):
    seed_instruments.seed(db_session)
    assert _fleet(db_session) == REAL


def test_seeding_twice_changes_nothing(db_session):
    seed_instruments.seed(db_session)
    ids = {i.serial_number: i.id for i in db_session.query(Instrument).all()}
    seed_instruments.seed(db_session)
    assert {i.serial_number: i.id for i in db_session.query(Instrument).all()} == ids


def test_the_early_demo_serials_are_renamed_in_place_and_keep_their_reports(db_session):
    legacy = [
        Instrument(name="FACSAria III", model="FACSAria III", serial_number="A47291", instrument_type="facs", status="active"),
        Instrument(name="FACSDiscover S8", model="FACSDiscover S8", serial_number="S80019", instrument_type="facs", status="active"),
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
    assert db_session.get(Instrument, aria_id).serial_number == "P648282B3003"
    assert db_session.get(models.Report, report.id).instrument_id == aria_id


def test_a_real_unit_already_added_by_hand_is_not_merged_with_the_demo_row(db_session):
    db_session.add_all(
        [
            Instrument(name="Old", model="FACSAria III", serial_number="A47291", instrument_type="facs", status="active"),
            Instrument(name="Mine", model="FACSAria III", serial_number="P648282B3003", instrument_type="facs", status="active"),
        ]
    )
    db_session.commit()

    seed_instruments.seed(db_session)  # must not raise a unique-serial error

    serials = sorted(s for (s,) in db_session.query(Instrument.serial_number).filter(Instrument.model == "FACSAria III"))
    assert serials == ["A47291", "P648282B3003"]


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
    assert rows["Y1033"].distributor == "almog diagnostic" and rows["Y1033"].instrument_type == "facs"
    assert rows["102579"].distributor == "Rhenium" and rows["102579"].instrument_type == "facs"
    assert rows["P648282B3003"].distributor is None


def test_seeding_fills_a_missing_distributor_but_keeps_one_a_person_set(db_session):
    seed_instruments.seed(db_session)
    rows = {i.serial_number: i for i in db_session.query(Instrument).all()}
    rows["Y1033"].distributor = None
    rows["102579"].distributor = "Someone else"
    db_session.commit()

    seed_instruments.seed(db_session)
    db_session.expire_all()
    rows = {i.serial_number: i for i in db_session.query(Instrument).all()}
    assert rows["Y1033"].distributor == "almog diagnostic"
    assert rows["102579"].distributor == "Someone else"


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
