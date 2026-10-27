"""Seeds the fixed fleet in scope for MVP (spec §1): three BD instruments, plus
the Cytek Aurora and CytoFLEX S from the Hebrew service reports.

Serial numbers match the ones already used across the architecture spec's
demos (new-report-demo.html, repair-review-demo.html) so a technician poking
at both the backend and the earlier UI mockups sees the same fleet.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Instrument
from app.services.instrument_types import ensure_default_types

INSTRUMENTS = [
    {"name": "FACSAria III", "model": "FACSAria III", "manufacturer": "BD", "serial_number": "P648282B3003", "location": "Core Lab"},
    {
        "name": "LSRFortessa",
        "model": "LSRFortessa",
        "manufacturer": "BD",
        "serial_number": "R647794E6092",
        "location": "Core Lab",
    },
    {
        "name": "FACSDiscover S8",
        "model": "FACSDiscover S8",
        "manufacturer": "BD",
        "serial_number": "MP6651580000057",
        "location": "Core Lab",
    },
    # The two instruments from the Hebrew service reports (docs: claude/
    # proposal-hebrew-translation.md). Neither maker is BD, and both were
    # serviced by an Israeli distributor whose form carries the report.
    # `institution` and `location` (the room) are as printed on each form.
    {
        "name": "Cytek Aurora",
        "model": "Cytek Aurora",
        "manufacturer": "Cytek Biosciences",
        "distributor": "almog diagnostic",
        "serial_number": "Y1033",
        "institution": "Bar-Ilan University",
        "location": "Room 205",
    },
    {
        "name": "CytoFLEX S",
        "model": "CytoFLEX S",
        "manufacturer": "Beckman Coulter",
        "distributor": "Rhenium",
        "serial_number": "102579",
        "institution": "Bar-Ilan University",
        "location": "Room C767",
    },
]

# The first versions of this seed used made-up serials for the Aria and the S8.
# A database seeded back then still has them: seed() renames those rows to the
# real serials in place (same row, so its reports stay attached) rather than
# adding second units of each model next to them — two units of one model stop
# a document being assigned by model alone (services/classification.py).
LEGACY_DEMO_SERIALS = {"A47291": "P648282B3003", "S80019": "MP6651580000057"}


def _migrate_legacy_serials(db: Session) -> None:
    for old, new in LEGACY_DEMO_SERIALS.items():
        legacy = db.query(Instrument).filter(Instrument.serial_number == old).one_or_none()
        if legacy is None:
            continue
        if db.query(Instrument).filter(Instrument.serial_number == new).one_or_none() is not None:
            # The real unit was already added by hand: leave both rather than
            # merge two rows that may each have their own reports.
            continue
        legacy.serial_number = new
    db.flush()


def seed(db: Session) -> list[Instrument]:
    ensure_default_types(db)
    _migrate_legacy_serials(db)
    created = []
    for spec in INSTRUMENTS:
        existing = db.query(Instrument).filter(Instrument.serial_number == spec["serial_number"]).one_or_none()
        if existing:
            # Units seeded before the manufacturer column existed: fill it in,
            # but never overwrite one a person has set.
            if existing.manufacturer is None:
                existing.manufacturer = spec["manufacturer"]
            if existing.distributor is None and spec.get("distributor"):
                existing.distributor = spec["distributor"]
            created.append(existing)
            continue
        row = Instrument(instrument_type="facs", status="active", **spec)
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        rows = seed(session)
        print(f"Seeded/updated {len(rows)} instruments:")
        for row in rows:
            print(f"  - {row.model:18s} S/N {row.serial_number}")
