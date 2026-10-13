"""Instrument types: the managed list behind `instrument_type`.

The key stored on instruments and templates must exist here. "facs" (shown as
"Flow cytometer") is the first type and is always present: the migration adds
it, and `ensure_default_types` re-adds it for databases built by
`create_all` (tests, fresh dev databases)."""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from app.models import InstrumentType

DEFAULT_TYPE_KEY = "facs"
DEFAULT_TYPE_NAME = "Flow cytometer"


def make_key(display_name: str) -> str:
    """"Electron microscope" -> "electron_microscope"."""
    return re.sub(r"[^a-z0-9]+", "_", display_name.strip().lower()).strip("_")


def ensure_default_types(db: Session) -> None:
    if not db.query(InstrumentType).filter(InstrumentType.key == DEFAULT_TYPE_KEY).first():
        db.add(InstrumentType(key=DEFAULT_TYPE_KEY, display_name=DEFAULT_TYPE_NAME))
        db.commit()


def type_exists(db: Session, key: str) -> bool:
    return db.query(InstrumentType.id).filter(InstrumentType.key == key).first() is not None


def display_name_for(db: Session, key: str) -> str:
    row = db.query(InstrumentType).filter(InstrumentType.key == key).first()
    return row.display_name if row else key
