"""Keeps `instruments.place_id` in step with the instrument's institution and
room text.

Step 1 of the places plan. An instrument points at the most specific place its
text names: a room (institution + room), else the institution alone. One
`before_flush` listener does it for every write path (the API, the seeds, tests
that build `Instrument` rows directly). Nothing is ever merged here; the tool
`list_places` only reports names that look alike so a person can decide. A room
with no institution has nowhere to sit, so that instrument stays unlinked.
"""
from __future__ import annotations

from sqlalchemy import event, func, inspect
from sqlalchemy.orm import Session

from app import models

INSTITUTION, FACULTY, ROOM = "institution", "faculty", "room"


def clean(text: str | None) -> str | None:
    """Trimmed, inner spaces collapsed; None when blank."""
    collapsed = " ".join((text or "").split())
    return collapsed or None


def same(a: str | None, b: str | None) -> bool:
    return (clean(a) or "").lower() == (clean(b) or "").lower()


def text_of(place: models.Place | None) -> tuple[str | None, str | None]:
    """(institution, room) text a place stands for."""
    if place is None:
        return None, None
    if place.kind == ROOM:
        parent = place.parent
        institution = parent.parent if parent is not None and parent.kind == FACULTY else parent
        return (institution.name if institution is not None else None), place.name
    if place.kind == FACULTY:
        return (place.parent.name if place.parent is not None else None), None
    return place.name, None


def subtree_ids(db: Session, place: models.Place) -> list:
    """The place's id and the ids of every place inside it."""
    ids, frontier = [place.id], [place.id]
    while frontier:
        frontier = [i for (i,) in db.query(models.Place.id).filter(models.Place.parent_id.in_(frontier)).all()]
        ids += frontier
    return ids


def refresh_instrument_text(db: Session, place: models.Place) -> int:
    """After a place is renamed, moved or merged into: the text on the
    instruments pointing at it or inside it follows the record (the record is the
    source). Returns how many instruments were looked at."""
    instruments = db.query(models.Instrument).filter(models.Instrument.place_id.in_(subtree_ids(db, place))).all()
    for instrument in instruments:
        institution, room = text_of(instrument.place)
        instrument.institution = institution
        if instrument.place.kind == ROOM:
            instrument.location = room
    return len(instruments)


def _needs_link(instrument: models.Instrument) -> bool:
    institution, room = clean(instrument.institution), clean(instrument.location)
    if instrument.place_id is None and instrument.place is None:
        return bool(institution or room)
    state = inspect(instrument)
    changed = state.attrs.institution.history.has_changes() or state.attrs.location.history.has_changes()
    if not changed:
        return False
    place_inst, place_room = text_of(instrument.place)
    return not (same(place_inst, institution) and same(place_room, room))


class _Resolver:
    def __init__(self, session: Session):
        self.session = session
        self.created: dict[tuple, models.Place] = {}

    def _find(self, kind: str, name: str, parent: models.Place | None) -> models.Place | None:
        key = (kind, id(parent) if parent is not None else None, name.lower())
        if key in self.created:
            return self.created[key]
        if parent is not None and parent.id is None:
            return None  # a parent made in this flush has no children yet
        query = self.session.query(models.Place).filter(models.Place.kind == kind, func.lower(models.Place.name) == name.lower())
        query = query.filter(models.Place.parent_id == (parent.id if parent is not None else None)) if parent is not None else query.filter(models.Place.parent_id.is_(None))
        return query.first()

    def get_or_create(self, kind: str, name: str, parent: models.Place | None) -> models.Place:
        found = self._find(kind, name, parent)
        if found is not None:
            return found
        place = models.Place(kind=kind, name=name, parent=parent)
        self.session.add(place)
        self.created[(kind, id(parent) if parent is not None else None, name.lower())] = place
        return place

    def room_in(self, institution: models.Place, name: str) -> models.Place | None:
        """A room of that name under the institution, directly or in one of its
        faculties. Several matches are ambiguous: None (never guessed)."""
        direct = self._find(ROOM, name, institution)
        if institution.id is None:  # made in this flush: it has no faculties yet
            return direct or self.get_or_create(ROOM, name, institution)
        faculties = self.session.query(models.Place.id).filter(models.Place.kind == FACULTY, models.Place.parent_id == institution.id)
        in_faculties = (
            self.session.query(models.Place)
            .filter(models.Place.kind == ROOM, func.lower(models.Place.name) == name.lower(), models.Place.parent_id.in_(faculties))
            .all()
        )
        matches = ([direct] if direct is not None else []) + in_faculties
        if len(matches) == 1:
            return matches[0]
        return None if matches else self.get_or_create(ROOM, name, institution)


def _link_instruments(session: Session, flush_context, instances) -> None:
    with session.no_autoflush:
        pending = [
            obj
            for obj in list(session.new) + list(session.dirty)
            if isinstance(obj, models.Instrument) and _needs_link(obj)
        ]
    if not pending:
        return
    resolver = _Resolver(session)
    with session.no_autoflush:
        for instrument in pending:
            institution_text, room_text = clean(instrument.institution), clean(instrument.location)
            if institution_text is None:
                instrument.place = None  # a room alone has no institution to sit in
                continue
            institution = resolver.get_or_create(INSTITUTION, institution_text, None)
            instrument.place = resolver.room_in(institution, room_text) if room_text else institution


event.listen(Session, "before_flush", _link_instruments)
