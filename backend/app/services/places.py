"""Where an instrument is: `instruments.place_id` is the only copy.

An instrument points at the most specific place known: a room, else a faculty,
else the institution. `Instrument.institution` and `Instrument.location` (the
room) are read from that place; writing them (the API, the seeds, tests that
build `Instrument` rows directly) is remembered, and one `before_flush` listener
turns it into the matching place, creating what is missing. Nothing is ever
merged here; the tool `list_places` only reports names that look alike so a
person can decide. Text that cannot name one place (a room with no institution,
or a room name found in several faculties of the institution) is refused with a
`PlaceTextError`, never guessed.
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


class PlaceTextError(ValueError):
    """The institution and room text cannot name one place; the message says why
    in words the person editing the instrument can act on."""


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
            for obj in list(session.new) + list(session.identity_map.values())
            if isinstance(obj, models.Instrument) and obj.__dict__.get("_text_edit") is not None
        ]
    if not pending:
        return
    resolver = _Resolver(session)
    with session.no_autoflush:
        for instrument in pending:
            institution_text, room_text = (clean(t) for t in instrument.__dict__.pop("_text_edit"))
            if institution_text is None:
                if room_text is not None:
                    raise PlaceTextError("A room needs an institution: fill in the institution too.")
                instrument.place = None
                continue
            institution = resolver.get_or_create(INSTITUTION, institution_text, None)
            if room_text is None:
                instrument.place = institution
                continue
            room = resolver.room_in(institution, room_text)
            if room is None:
                raise PlaceTextError(
                    f"{institution_text} has several rooms named {room_text} (in different faculties). "
                    "Rename one of them on the Places screen first."
                )
            instrument.place = room


event.listen(Session, "before_flush", _link_instruments)
