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

from sqlalchemy import event, func, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models
from app.services.domain_errors import ConflictError, InvalidError, NotFoundError

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


def is_maker(db: Session | None, text: str | None, known_name: str) -> bool:
    """True when `text` names the maker that is also known as `known_name` ("BD", say):
    by that maker's name or any other name, so "Becton Dickinson" is BD and a maker
    someone renamed still counts. False for empty text or a maker that is not it."""
    if db is None:  # unit tests call the classifier without a session: use the built-in names
        names = next(([n, *al] for n, al in DEFAULT_MAKERS if normalize(n) == normalize(known_name)), [known_name])
        return bool(text) and normalize(text) in {normalize(n) for n in names}
    maker = find_maker(db.query(models.Manufacturer).all(), text)
    return maker is not None and matches(maker, known_name)


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


# ---------- maker records for the API (routers/manufacturers.py) ----------

_CONFLICT = "Another maker already has this name or alias"


def usage_counts(db: Session, maker: models.Manufacturer) -> tuple[int, int]:
    """How many instruments and how many models point at this maker."""
    instruments = db.query(func.count(models.Instrument.id)).filter(models.Instrument.manufacturer_id == maker.id).scalar() or 0
    model_records = db.query(func.count(models.InstrumentModel.id)).filter(models.InstrumentModel.manufacturer_id == maker.id).scalar() or 0
    return instruments, model_records


def spellings(name: str, aliases: list[str]) -> tuple[str, list[str]]:
    """Trimmed name and aliases: blanks, repeats and the name itself dropped."""
    name = clean(name) or ""
    if not normalize(name):
        raise InvalidError("The maker needs a name with at least one letter or digit")
    kept: list[str] = []
    seen = {normalize(name)}
    for alias in aliases:
        alias = clean(alias)
        if alias and normalize(alias) and normalize(alias) not in seen:
            seen.add(normalize(alias))
            kept.append(alias)
    return name, kept


def _clash(db: Session, name: str, aliases: list[str], own_id: uuid.UUID | None) -> bool:
    """True when another maker already answers to the name or to one of the aliases."""
    others = db.query(models.Manufacturer).filter(models.Manufacturer.id != own_id).all() if own_id else db.query(models.Manufacturer).all()
    return any(matches(other, text) for other in others for text in (name, *aliases))


def list_makers(db: Session) -> list[models.Manufacturer]:
    return db.query(models.Manufacturer).order_by(func.lower(models.Manufacturer.name)).all()


def create_maker(db: Session, name: str, aliases: list[str]) -> models.Manufacturer:
    name, aliases = spellings(name, aliases)
    if _clash(db, name, aliases, None):
        raise ConflictError(_CONFLICT)
    maker = models.Manufacturer(name=name, aliases=aliases)
    db.add(maker)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_CONFLICT)
    db.refresh(maker)
    return maker


def update_maker(db: Session, maker_id: uuid.UUID, name: str | None, aliases: list[str] | None) -> models.Manufacturer:
    """Renames a maker and/or replaces its aliases (None keeps what it has). A rename
    is copied onto the instruments and models that point at it, so their text keeps
    matching. Two makers are never merged here: a name or alias another maker answers
    to is refused."""
    maker = db.get(models.Manufacturer, maker_id)
    if not maker:
        raise NotFoundError("Maker not found")
    name, aliases = spellings(name if name is not None else maker.name, aliases if aliases is not None else maker.aliases)
    if _clash(db, name, aliases, maker.id):
        raise ConflictError(_CONFLICT)
    renamed = name != maker.name
    maker.name = name
    maker.aliases = aliases
    if renamed:
        for table in (models.Instrument, models.InstrumentModel):
            db.execute(update(table).where(table.manufacturer_id == maker.id).values(manufacturer=name))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_CONFLICT)
    db.refresh(maker)
    return maker


def delete_maker(db: Session, maker_id: uuid.UUID) -> None:
    maker = db.get(models.Manufacturer, maker_id)
    if not maker:
        raise NotFoundError("Maker not found")
    instruments, model_records = usage_counts(db, maker)
    if instruments or model_records:
        raise ConflictError("This maker is still used by instruments or models; change those first")
    db.delete(maker)
    db.commit()
