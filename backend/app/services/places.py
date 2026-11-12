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

import uuid

from sqlalchemy import event, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.services.domain_errors import ConflictError, InvalidError, NotFoundError
from app.services.instrument_models import near_duplicates

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
                    raise PlaceTextError("A room needs an institute: fill in the institute too.")
                instrument.place = None
                continue
            institution = resolver.get_or_create(INSTITUTION, institution_text, None)
            if room_text is None:
                instrument.place = institution
                continue
            room = resolver.room_in(institution, room_text)
            if room is None:
                raise PlaceTextError(
                    f"{institution_text} has several rooms named {room_text} (in different buildings). "
                    "Rename one of them on the Places screen first."
                )
            instrument.place = room


event.listen(Session, "before_flush", _link_instruments)


# ---------- place records for the API (routers/places.py) ----------

_PARENT_KINDS = {INSTITUTION: (), FACULTY: (INSTITUTION,), ROOM: (INSTITUTION, FACULTY)}
# What people read. The stored kinds keep their old names (institution, faculty); the words shown are
# "institute" and "building". Always go through these, never the raw kind, in a message.
_WORD = {INSTITUTION: "institute", FACULTY: "building", ROOM: "room"}
_PLURAL = {INSTITUTION: "institutes", FACULTY: "buildings", ROOM: "rooms"}


def _a(kind: str) -> str:
    """\"an institute\", \"a building\", \"a room\"."""
    word = _WORD[kind]
    return f"{'an' if word[0] in 'aeiou' else 'a'} {word}"


def _plural(kind: str, n: int) -> str:
    return f"{n} {_WORD[kind]}" if n == 1 else f"{n} {_PLURAL[kind]}"


def _out(
    place: models.Place,
    by_id: dict[uuid.UUID, models.Place],
    direct: dict[uuid.UUID, int],
    children: dict[uuid.UUID, list[uuid.UUID]],
    similar: dict[tuple[str, str], list[str]],
) -> schemas.PlaceOut:
    def total(pid: uuid.UUID) -> int:
        return direct.get(pid, 0) + sum(total(c) for c in children.get(pid, []))

    faculty = None
    institution = place
    if place.kind == ROOM:
        parent = by_id[place.parent_id]
        if parent.kind == FACULTY:
            faculty, institution = parent, by_id[parent.parent_id]
        else:
            institution = parent
    elif place.kind == FACULTY:
        institution = by_id[place.parent_id]
    return schemas.PlaceOut(
        id=place.id,
        kind=place.kind,
        name=place.name,
        parent_id=place.parent_id,
        institution_id=institution.id,
        institution_name=institution.name,
        faculty_id=faculty.id if faculty else None,
        faculty_name=faculty.name if faculty else None,
        unit_count=direct.get(place.id, 0),
        total_unit_count=total(place.id),
        child_count=len(children.get(place.id, [])),
        similar_to=similar.get((place.kind, place.name), []),
    )


def _all(db: Session) -> list[schemas.PlaceOut]:
    places = db.query(models.Place).all()
    by_id = {p.id: p for p in places}
    direct = dict(
        db.query(models.Instrument.place_id, func.count(models.Instrument.id))
        .filter(models.Instrument.place_id.isnot(None))
        .group_by(models.Instrument.place_id)
        .all()
    )
    children: dict[uuid.UUID, list[uuid.UUID]] = {}
    for p in places:
        if p.parent_id is not None:
            children.setdefault(p.parent_id, []).append(p.id)
    similar: dict[tuple[str, str], list[str]] = {}
    for kind in _PARENT_KINDS:
        for group in near_duplicates([p.name for p in places if p.kind == kind], contains=True):
            for name in group:
                similar[(kind, name)] = [n for n in group if n != name]
    rows = [_out(p, by_id, direct, children, similar) for p in places]
    return sorted(rows, key=lambda r: (r.institution_name.lower(), r.kind != INSTITUTION, (r.faculty_name or "").lower(), r.kind != FACULTY, r.name.lower()))


def _one(db: Session, place_id: uuid.UUID) -> schemas.PlaceOut:
    return next(r for r in _all(db) if r.id == place_id)


def _clash(db: Session, kind: str, parent_id: uuid.UUID | None, name: str, exclude: uuid.UUID | None = None) -> models.Place | None:
    query = db.query(models.Place).filter(models.Place.kind == kind, func.lower(models.Place.name) == name.lower())
    query = query.filter(models.Place.parent_id.is_(None)) if parent_id is None else query.filter(models.Place.parent_id == parent_id)
    if exclude is not None:
        query = query.filter(models.Place.id != exclude)
    return query.first()


def _check_parent(db: Session, kind: str, parent_id: uuid.UUID | None) -> models.Place | None:
    if kind == INSTITUTION:
        if parent_id is not None:
            raise InvalidError("An institute has no parent.")
        return None
    if parent_id is None:
        raise InvalidError(f"{_a(kind).capitalize()} must be inside {'an institute' if kind == FACULTY else 'an institute or a building'}.")
    parent = db.get(models.Place, parent_id)
    if parent is None:
        raise NotFoundError("Parent place not found")
    if parent.kind not in _PARENT_KINDS[kind]:
        allowed = " or ".join(_a(k) for k in _PARENT_KINDS[kind])
        raise InvalidError(f"{_a(kind).capitalize()} must be inside {allowed}, not {_a(parent.kind)}.")
    return parent


def _name_conflict(kind: str, name: str, parent: models.Place | None) -> str:
    where = f" in {parent.name}" if parent is not None else ""
    return f"There is already {_a(kind)} called “{name}”{where}."


def all_places(db: Session) -> list[schemas.PlaceOut]:
    return _all(db)


def create_place(db: Session, payload: schemas.PlaceCreate) -> schemas.PlaceOut:
    parent = _check_parent(db, payload.kind, payload.parent_id)
    if _clash(db, payload.kind, payload.parent_id, payload.name):
        raise ConflictError(_name_conflict(payload.kind, payload.name, parent))
    place = models.Place(kind=payload.kind, name=payload.name, parent_id=payload.parent_id)
    db.add(place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_name_conflict(payload.kind, payload.name, parent)) from None
    return _one(db, place.id)


def update_place(db: Session, place_id: uuid.UUID, payload: schemas.PlaceUpdate) -> schemas.PlaceOut:
    place = db.get(models.Place, place_id)
    if not place:
        raise NotFoundError("Place not found")
    provided = payload.model_fields_set
    if "name" in provided and payload.name is None:
        raise InvalidError("name cannot be null — omit it to leave it unchanged.")

    new_parent_id = payload.parent_id if "parent_id" in provided else place.parent_id
    new_name = payload.name if "name" in provided else place.name
    parent = _check_parent(db, place.kind, new_parent_id)
    if (new_parent_id, new_name.lower()) != (place.parent_id, place.name.lower()) and _clash(db, place.kind, new_parent_id, new_name, place.id):
        raise ConflictError(_name_conflict(place.kind, new_name, parent))
    place.name = new_name
    place.parent_id = new_parent_id
    db.flush()
    db.expire(place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError(_name_conflict(place.kind, new_name, parent)) from None
    return _one(db, place_id)


def delete_place(db: Session, place_id: uuid.UUID) -> None:
    place = db.get(models.Place, place_id)
    if not place:
        raise NotFoundError("Place not found")
    inside = db.query(models.Place).filter(models.Place.parent_id == place.id).all()
    if inside:
        kinds = inside[0].kind
        raise ConflictError(f"{_plural(kinds, len(inside))} {'is' if len(inside) == 1 else 'are'} inside “{place.name}”. "
            "Move them elsewhere, or merge this place into another, first.",
        )
    units = db.query(models.Instrument).filter(models.Instrument.place_id == place.id).count()
    if units:
        raise ConflictError(f"{units} instrument{'s' if units != 1 else ''} {'are' if units != 1 else 'is'} in “{place.name}”. "
            "Change their place, or merge this place into another, first.",
        )
    db.delete(place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ConflictError("An instrument was just added here — try again.") from None


def merge_place(db: Session, place_id: uuid.UUID, payload: schemas.PlaceMerge) -> schemas.PlaceMergeOut:
    source = db.get(models.Place, place_id)
    target = db.get(models.Place, payload.into_id)
    if not source or not target:
        raise NotFoundError("Place not found")
    if source.id == target.id:
        raise InvalidError("Pick a different place to merge into.")
    if source.kind != target.kind:
        raise InvalidError(f"Only places of the same kind can be merged: this is {_a(source.kind)}, the other is {_a(target.kind)}.")

    inside = db.query(models.Place).filter(models.Place.parent_id == source.id).all()
    for child in inside:
        twin = _clash(db, child.kind, target.id, child.name)
        if twin is not None:
            raise ConflictError(f"Both have {_a(child.kind)} called “{child.name}”. Merge those two first, then merge “{source.name}”.",
            )

    direct = db.query(models.Instrument).filter(models.Instrument.place_id == source.id).all()
    for child in inside:
        child.parent_id = target.id
    for instrument in direct:
        instrument.place = target
    db.flush()
    db.expire_all()
    target = db.get(models.Place, target.id)
    db.flush()
    db.delete(db.get(models.Place, source.id))
    db.commit()
    return schemas.PlaceMergeOut(moved_instruments=len(direct), moved_places=len(inside), into=target.name)
