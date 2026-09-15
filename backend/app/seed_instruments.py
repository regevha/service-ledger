"""Seeds the fixed three-instrument fleet in scope for MVP (spec §1).

Serial numbers match the ones already used across the architecture spec's
demos (new-report-demo.html, repair-review-demo.html) so a technician poking
at both the backend and the earlier UI mockups sees the same fleet.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import Instrument

INSTRUMENTS = [
    {"name": "FACSAria III", "model": "FACSAria III", "serial_number": "A47291", "location": "Core Lab, Bench 3"},
    {
        "name": "LSRFortessa",
        "model": "LSRFortessa",
        "serial_number": "R647794E6092",
        "location": "Core Lab, Bench 1",
    },
    {
        "name": "FACSDiscover S8",
        "model": "FACSDiscover S8",
        "serial_number": "S80019",
        "location": "Core Lab, Bench 5",
    },
]


def seed(db: Session) -> list[Instrument]:
    created = []
    for spec in INSTRUMENTS:
        existing = db.query(Instrument).filter(Instrument.serial_number == spec["serial_number"]).one_or_none()
        if existing:
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
