"""Instrument types: the managed list behind `instrument_type`.

The key stored on instruments and templates must exist here. "flow_cytometer" (shown as
"Flow cytometer"; it was "facs" until migration 0009) is the first type; the migration adds it, and
`ensure_default_types` (run by the seed and at app startup) adds it and the
other seeded types (Electron microscope, ImageStream, Mass spectrometer, PCR
machine) wherever they are missing, including databases built by `create_all`
(tests, fresh dev databases) and ones migrated before they were added."""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from app.models import DEFAULT_INSTRUMENT_TYPE_KEY, InstrumentType

DEFAULT_TYPE_KEY = DEFAULT_INSTRUMENT_TYPE_KEY
DEFAULT_TYPE_NAME = "Flow cytometer"

# Seeded types, in this order. "flow_cytometer" is the default type; the others get
# the key `make_key` derives from the display name. More can be added in the app.
DEFAULT_TYPES = [
    (DEFAULT_TYPE_KEY, DEFAULT_TYPE_NAME),
    ("electron_microscope", "Electron microscope"),
    ("imagestream", "ImageStream"),
    ("mass_spectrometer", "Mass spectrometer"),
    ("pcr_machine", "PCR machine"),
]


def make_key(display_name: str) -> str:
    """"Electron microscope" -> "electron_microscope"."""
    return re.sub(r"[^a-z0-9]+", "_", display_name.strip().lower()).strip("_")


def ensure_default_types(db: Session) -> None:
    """Adds any seeded type that is missing. Idempotent, and never renames or
    removes a type someone has added or changed."""
    present = {key for (key,) in db.query(InstrumentType.key).all()}
    missing = [(k, n) for k, n in DEFAULT_TYPES if k not in present]
    if missing:
        db.add_all(InstrumentType(key=k, display_name=n) for k, n in missing)
        db.commit()


def type_exists(db: Session, key: str) -> bool:
    return db.query(InstrumentType.id).filter(InstrumentType.key == key).first() is not None


def display_name_for(db: Session, key: str) -> str:
    row = db.query(InstrumentType).filter(InstrumentType.key == key).first()
    return row.display_name if row else key
