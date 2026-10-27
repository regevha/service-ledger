"""Lists the places (institutions, faculties, rooms) and the names that look like the same place.

    python -m app.tools.list_places

Read-only. The migration and the app never merge place names; this is how a
person sees which ones to look at (step 2 of the places plan adds the merge).
"""
from __future__ import annotations

from sqlalchemy import func

from app import models
from app.db import SessionLocal
from app.services.instrument_models import near_duplicates


def main() -> None:
    with SessionLocal() as db:
        places = db.query(models.Place).order_by(models.Place.kind, models.Place.name).all()
        counts = dict(
            db.query(models.Instrument.place_id, func.count(models.Instrument.id))
            .filter(models.Instrument.place_id.isnot(None))
            .group_by(models.Instrument.place_id)
            .all()
        )
        names = {p.id: p.name for p in places}
        unlinked = (
            db.query(models.Instrument)
            .filter(models.Instrument.place_id.is_(None))
            .filter((models.Instrument.institution.isnot(None)) | (models.Instrument.location.isnot(None)))
            .all()
        )
    print(f"{len(places)} places; {len(unlinked)} instruments with a place in text but no link")
    for kind in ("institution", "faculty", "room"):
        group = [p for p in places if p.kind == kind]
        if not group:
            continue
        print(f"\n{kind}s")
        for p in group:
            parent = f" in {names[p.parent_id]}" if p.parent_id is not None else ""
            print(f"  {p.name}{parent}: {counts.get(p.id, 0)} instrument(s) pointing directly here")
    if unlinked:
        print("\nNot linked (a room needs an institution to sit in):")
        for i in unlinked:
            print(f"  {i.name} ({i.serial_number}): institution={i.institution!r} room={i.location!r}")
    for kind in ("institution", "room"):
        groups = near_duplicates([p.name for p in places if p.kind == kind], contains=True)
        if groups:
            print(f"\n{kind.capitalize()} names that may be the same place (nothing was merged):")
            for group in groups:
                print("  - " + "  |  ".join(group))
    print("")


if __name__ == "__main__":
    main()
