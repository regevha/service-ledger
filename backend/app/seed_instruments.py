"""Seeds the fixed fleet in scope for MVP (spec §1): three BD instruments, plus
the Cytek Aurora and CytoFLEX S (both shaped on the Hebrew service reports; every
serial, institution and distributor name here is invented).

Serial numbers match the ones already used across the architecture spec's
demos (new-report-demo.html, repair-review-demo.html) so a technician poking
at both the backend and the earlier UI mockups sees the same fleet.
"""
from __future__ import annotations

import hashlib

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import DEFAULT_INSTRUMENT_TYPE_KEY, Instrument
from app.services.instrument_types import ensure_default_types
from app.services.manufacturers import ensure_default_makers

INSTRUMENTS = [
    {"name": "FACSAria III", "model": "FACSAria III", "manufacturer": "BD", "serial_number": "P900001A0003", "institution": "Demo Institution", "location": "Core Lab"},
    {
        "name": "LSRFortessa",
        "model": "LSRFortessa",
        "manufacturer": "BD",
        "serial_number": "R900002A0092",
        "institution": "Demo Institution",
        "location": "Core Lab",
    },
    {
        "name": "FACSDiscover S8",
        "model": "FACSDiscover S8",
        "manufacturer": "BD",
        "serial_number": "MP9000030000057",
        "institution": "Demo Institution",
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
        "distributor": "sigma diagnostics",
        "serial_number": "Y9004",
        "institution": "Alpha University",
        "location": "Room 101",
    },
    {
        "name": "CytoFLEX S",
        "model": "CytoFLEX S",
        "manufacturer": "Beckman Coulter",
        "distributor": "Omega Distribution",
        "serial_number": "900005",
        "institution": "Alpha University",
        "location": "Room C100",
    },
]

# The first versions of this seed used other serials for the instruments below.
# A database seeded back then still has them: seed() renames those rows to the
# current serials in place (same row, so its reports stay attached) rather than
# adding second units of each model next to them — two units of one model stop
# a document being assigned by model alone (services/classification.py).
LEGACY_DEMO_SERIALS = {"A47291": "P900001A0003", "S80019": "MP9000030000057"}

# Later versions seeded the serials printed on real forms. The seed now uses
# invented ones, so a database seeded with the earlier values is moved the same
# way. The old values are kept only as SHA-256 hashes (this repository is public):
# the SHA-256 of the old serial maps to its replacement.
REPLACED_SERIAL_HASHES = {
    "6ba29d2a6f0a3fdf0428d74f41eb2b70dc53f1c1411813be4bf7db06f3783a12": "P900001A0003",
    "4b510c43c63c80c9d85656021997f0080aab789a03cc564e69af3170a70e57ff": "R900002A0092",
    "7163c5bf4b310770dd6769b947ab74e2d6e6952b10436c03b48247a4ebe942de": "MP9000030000057",
    "5ad48941b3f7a4babe6a6d2cba044cf80d93123e28af13db142be9ab5bb68feb": "Y9004",
    "fb9896ba0def8900c0c3f8b194c35ea6f40f7f00d448440f0cd811edf4871b73": "900005",
}


def _rename_serial(db: Session, row: Instrument, new: str) -> None:
    if db.query(Instrument).filter(Instrument.serial_number == new).one_or_none() is not None:
        # The new unit was already added by hand: leave both rather than
        # merge two rows that may each have their own reports.
        return
    row.serial_number = new


def _migrate_legacy_serials(db: Session) -> None:
    for old, new in LEGACY_DEMO_SERIALS.items():
        legacy = db.query(Instrument).filter(Instrument.serial_number == old).one_or_none()
        if legacy is not None:
            _rename_serial(db, legacy, new)
    for row in db.query(Instrument).all():
        new = REPLACED_SERIAL_HASHES.get(hashlib.sha256((row.serial_number or "").encode()).hexdigest())
        if new is not None:
            _rename_serial(db, row, new)
    db.flush()


def seed(db: Session) -> list[Instrument]:
    ensure_default_types(db)
    ensure_default_makers(db)
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
        row = Instrument(instrument_type=DEFAULT_INSTRUMENT_TYPE_KEY, status="active", **spec)
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
