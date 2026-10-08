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
