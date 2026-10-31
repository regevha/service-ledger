"""Makers as records: one `Manufacturer` row per maker, however it was typed.

Instruments and instrument models carry a `manufacturer` text and a link to a
`Manufacturer`. One `before_flush` listener keeps them in step on every write path
(the API, the seeds, tests that build rows directly), the same way
services/instrument_models.py does for models: the typed text is matched to a maker
by name or alias (ignoring case, spaces and punctuation), the row takes the maker's
canonical name, and a text that matches nothing creates a new maker. Nothing is merged
by guess: only a spelling someone has listed as an alias joins a maker.
"""
from __future__ import annotations

import re
import uuid

from sqlalchemy import event
from sqlalchemy.orm import Session

from app import models

# Makers the app knows by name, with the other spellings seen on service reports.
# Added at startup when missing; an existing maker only gains missing aliases.
DEFAULT_MAKERS: list[tuple[str, list[str]]] = [
    ("BD", ["Becton Dickinson", "Becton, Dickinson and Company", "BD Biosciences", "BD Life Sciences"]),
    ("Cytek Biosciences", ["Cytek"]),
    ("Beckman Coulter", ["Beckman", "Beckman Coulter Life Sciences"]),
]


def normalize(text: str) -> str:
    """"Becton, Dickinson" -> "bectondickinson": lower case, letters and digits only."""
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def clean(text: str | None) -> str | None:
    """The text with spaces collapsed; None when nothing is left."""
    if text is None:
        return None
    cleaned = re.sub(r"\s+", " ", text).strip()
    return cleaned or None


def matches(maker: models.Manufacturer, text: str) -> bool:
    key = normalize(text)
    return bool(key) and (normalize(maker.name) == key or key in {normalize(a) for a in (maker.aliases or [])})


def find_maker(makers, text: str | None) -> models.Manufacturer | None:
    """The maker among `makers` that `text` names (by name or alias), else None."""
    text = clean(text)
    if text is None:
        return None
    return next((m for m in makers if matches(m, text)), None)


def canonical_name(db: Session, text: str | None) -> str | None:
    """What `text` is called once matched to a known maker; the text itself (spaces
    collapsed) when no maker matches. Nothing is created."""
    cleaned = clean(text)
    maker = find_maker(db.query(models.Manufacturer).all(), cleaned)
    return maker.name if maker else cleaned


def ensure_default_makers(db: Session) -> None:
    """Adds any known maker that is missing and any missing alias on one that exists.
    Idempotent; never renames or removes anything."""
    makers = db.query(models.Manufacturer).all()
    changed = False
    for name, aliases in DEFAULT_MAKERS:
        # A known maker counts as present if any of its names is already a maker's name
        # or alias, so a maker someone renamed is not created a second time.
        maker = next((m for text in (name, *aliases) if (m := find_maker(makers, text))), None)
        if maker is None:
            maker = models.Manufacturer(name=name, aliases=list(aliases))
            db.add(maker)
            makers.append(maker)
            changed = True
            continue
        have = {normalize(maker.name), *(normalize(a) for a in maker.aliases or [])}
        missing = [a for a in (name, *aliases) if normalize(a) not in have]
        if missing:
            maker.aliases = [*(maker.aliases or []), *missing]
            changed = True
    if changed:
        db.commit()


def _link_makers(session: Session, flush_context, instances) -> None:
    pending = [
        obj
        for obj in list(session.new) + list(session.dirty)
        if isinstance(obj, (models.Instrument, models.InstrumentModel))
    ]
    if not pending:
        return
    with session.no_autoflush:
        makers: list[models.Manufacturer] | None = None
        for obj in pending:
            text = clean(obj.manufacturer)
            if text is None:
                obj.manufacturer = None
                obj.manufacturer_record = None
                continue
            if makers is None:
                known = {m.id: m for m in session.query(models.Manufacturer).all()}
                for m in session.new:
                    if isinstance(m, models.Manufacturer):
                        known[m.id or id(m)] = m
                makers = list(known.values())
            maker = find_maker(makers, text)
            if maker is None:
                maker = models.Manufacturer(id=uuid.uuid4(), name=text, aliases=[])
                session.add(maker)
                makers.append(maker)
            obj.manufacturer = maker.name
            obj.manufacturer_record = maker


event.listen(Session, "before_flush", _link_makers)
