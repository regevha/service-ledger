"""Lists the instrument models and the names that look like the same model.

    python -m app.tools.list_instrument_models

Read-only. The migration and the app never merge model names; this is how a
person sees which ones to look at (step 2 of the models plan adds the merge).
"""
from __future__ import annotations

from sqlalchemy import func

from app import models
from app.db import SessionLocal
from app.services.instrument_models import near_duplicates


def main() -> None:
    with SessionLocal() as db:
        rows = (
            db.query(models.InstrumentModel, func.count(models.Instrument.id))
            .outerjoin(models.Instrument, models.Instrument.model_id == models.InstrumentModel.id)
            .group_by(models.InstrumentModel.id)
            .order_by(models.InstrumentModel.name)
            .all()
        )
        unlinked = db.query(models.Instrument).filter(models.Instrument.model_id.is_(None)).count()
    print(f"{len(rows)} models, {unlinked} instruments without a model record")
    for record, units in rows:
        print(f"  {record.name}  ({record.manufacturer or 'no maker'}, {record.instrument_type}): {units} unit(s)")
    groups = near_duplicates([r.name for r, _ in rows])
    if groups:
        print("\nNames that may be the same model (nothing was merged):")
        for group in groups:
            print("  - " + "  |  ".join(group))
    else:
        print("\nNo near-duplicate names.")


if __name__ == "__main__":
    main()
