"""Keeps `instruments.model_id` in step with the instrument's model text.

Step 1 of the models plan: every instrument points at an `InstrumentModel`
whose `name` is exactly the instrument's `model` text. One `before_flush`
listener does it for every write path (the API, the seeds, tests that build
`Instrument` rows directly), so nothing else has to remember to. A new model
record takes the first instrument's manufacturer and type. Nothing is ever
merged here; `near_duplicates` only reports names that look alike so a person
can decide.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app import models

SIMILARITY = 0.88


def _normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def near_duplicates(names: list[str]) -> list[list[str]]:
    """Groups of two or more distinct names that probably mean the same model
    (equal once case, spaces and punctuation are ignored, or very similar)."""
    distinct = sorted(set(names))
    parent = {n: n for n in distinct}

    def find(n: str) -> str:
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for i, a in enumerate(distinct):
        for b in distinct[i + 1 :]:
            na, nb = _normalize(a), _normalize(b)
            if na and (na == nb or SequenceMatcher(None, na, nb).ratio() >= SIMILARITY):
                parent[find(b)] = find(a)
    groups: dict[str, list[str]] = {}
    for n in distinct:
        groups.setdefault(find(n), []).append(n)
    return [g for g in groups.values() if len(g) > 1]


def _link_instruments(session: Session, flush_context, instances) -> None:
    pending = [
        obj
        for obj in list(session.new) + list(session.dirty)
        if isinstance(obj, models.Instrument)
        and obj.model
        and (obj.model_id is None or _stale(session, obj))
    ]
    if not pending:
        return
    created = {obj.name: obj for obj in session.new if isinstance(obj, models.InstrumentModel)}
    with session.no_autoflush:
        for instrument in pending:
            record = created.get(instrument.model)
            if record is None:
                record = session.query(models.InstrumentModel).filter(models.InstrumentModel.name == instrument.model).first()
            if record is None:
                record = models.InstrumentModel(
                    name=instrument.model,
                    manufacturer=instrument.manufacturer,
                    instrument_type=instrument.instrument_type or "facs",
                )
                session.add(record)
                created[record.name] = record
            instrument.model_record = record


def _stale(session: Session, instrument: models.Instrument) -> bool:
    """The model text was edited in this unit of work and no longer matches
    the linked record (renaming a record edits its units' text to match)."""
    if not inspect(instrument).attrs.model.history.has_changes():
        return False
    record = instrument.model_record
    return record is None or record.name != instrument.model


def type_conflict(db: Session, model_text: str, instrument_type: str) -> str | None:
    """A message when `model_text` is already a model of a different instrument
    type (an instrument's type cannot change, so it cannot join that model)."""
    record = db.query(models.InstrumentModel).filter(models.InstrumentModel.name == model_text).first()
    if record is not None and record.instrument_type != instrument_type:
        return f"“{model_text}” is already a model of type {record.instrument_type}, not {instrument_type}."
    return None


event.listen(Session, "before_flush", _link_instruments)


def lock_manufacturer(db: Session, instrument: models.Instrument) -> None:
    """An instrument's manufacturer follows its model. If a record for the
    instrument's model text exists, the instrument takes the record's
    manufacturer, whatever was submitted. A record that has no manufacturer yet
    adopts the submitted one, once, so the gap is filled and then locked."""
    record = db.query(models.InstrumentModel).filter(models.InstrumentModel.name == instrument.model).first()
    if record is None:
        return
    if record.manufacturer is None:
        record.manufacturer = instrument.manufacturer
    else:
        instrument.manufacturer = record.manufacturer
