"""Places as records you can manage (places plan, step 2).

The place record is the source: renaming it, or moving it, updates the
institution and room text on the instruments in it in the same transaction.
Nothing is merged unless a person asks for it here. Kinds nest: an institution
has no parent; a faculty sits in an institution; a room sits in an institution
or a faculty.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas
from app.db import get_db
from app.services.instrument_models import near_duplicates
from app.services.places import FACULTY, INSTITUTION, ROOM, refresh_instrument_text

router = APIRouter(tags=["places"])

_PARENT_KINDS = {INSTITUTION: (), FACULTY: (INSTITUTION,), ROOM: (INSTITUTION, FACULTY)}
_PLURAL = {INSTITUTION: "institutions", FACULTY: "faculties", ROOM: "rooms"}


def _plural(kind: str, n: int) -> str:
    return f"{n} {kind}" if n == 1 else f"{n} {_PLURAL[kind]}"


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
            raise HTTPException(422, "An institution has no parent.")
        return None
    if parent_id is None:
        raise HTTPException(422, f"A {kind} must be inside {'an institution' if kind == FACULTY else 'an institution or a faculty'}.")
    parent = db.get(models.Place, parent_id)
    if parent is None:
        raise HTTPException(404, "Parent place not found")
    if parent.kind not in _PARENT_KINDS[kind]:
        allowed = " or ".join(_PARENT_KINDS[kind])
        raise HTTPException(422, f"A {kind} must be inside a {allowed}, not a {parent.kind}.")
    return parent


def _name_conflict(kind: str, name: str, parent: models.Place | None) -> str:
    where = f" in {parent.name}" if parent is not None else ""
    return f"There is already a {kind} called “{name}”{where}."


@router.get("/places", response_model=list[schemas.PlaceOut])
def list_places(db: Session = Depends(get_db)):
    return _all(db)


@router.post("/places", response_model=schemas.PlaceOut, status_code=201)
def create_place(payload: schemas.PlaceCreate, db: Session = Depends(get_db)):
    parent = _check_parent(db, payload.kind, payload.parent_id)
    if _clash(db, payload.kind, payload.parent_id, payload.name):
        raise HTTPException(409, _name_conflict(payload.kind, payload.name, parent))
    place = models.Place(kind=payload.kind, name=payload.name, parent_id=payload.parent_id)
    db.add(place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _name_conflict(payload.kind, payload.name, parent)) from None
    return _one(db, place.id)


@router.patch("/places/{place_id}", response_model=schemas.PlaceOut)
def update_place(place_id: uuid.UUID, payload: schemas.PlaceUpdate, db: Session = Depends(get_db)):
    place = db.get(models.Place, place_id)
    if not place:
        raise HTTPException(404, "Place not found")
    provided = payload.model_fields_set
    if "name" in provided and payload.name is None:
        raise HTTPException(422, "name cannot be null — omit it to leave it unchanged.")

    new_parent_id = payload.parent_id if "parent_id" in provided else place.parent_id
    new_name = payload.name if "name" in provided else place.name
    parent = _check_parent(db, place.kind, new_parent_id)
    if (new_parent_id, new_name.lower()) != (place.parent_id, place.name.lower()) and _clash(db, place.kind, new_parent_id, new_name, place.id):
        raise HTTPException(409, _name_conflict(place.kind, new_name, parent))
    place.name = new_name
    place.parent_id = new_parent_id
    db.flush()
    db.expire(place)
    refresh_instrument_text(db, place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, _name_conflict(place.kind, new_name, parent)) from None
    return _one(db, place_id)


@router.delete("/places/{place_id}", status_code=204)
def delete_place(place_id: uuid.UUID, db: Session = Depends(get_db)):
    """Removes a place that nothing is in and no instrument points at."""
    place = db.get(models.Place, place_id)
    if not place:
        raise HTTPException(404, "Place not found")
    inside = db.query(models.Place).filter(models.Place.parent_id == place.id).all()
    if inside:
        kinds = inside[0].kind
        raise HTTPException(
            409,
            f"{_plural(kinds, len(inside))} {'is' if len(inside) == 1 else 'are'} inside “{place.name}”. "
            "Move them elsewhere, or merge this place into another, first.",
        )
    units = db.query(models.Instrument).filter(models.Instrument.place_id == place.id).count()
    if units:
        raise HTTPException(
            409,
            f"{units} instrument{'s' if units != 1 else ''} {'are' if units != 1 else 'is'} in “{place.name}”. "
            "Change their place, or merge this place into another, first.",
        )
    db.delete(place)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An instrument was just added here — try again.") from None


@router.post("/places/{place_id}/merge", response_model=schemas.PlaceMergeOut)
def merge_place(place_id: uuid.UUID, payload: schemas.PlaceMerge, db: Session = Depends(get_db)):
    """Moves the instruments pointing at this place, and the places inside it, to
    another place of the same kind, then removes this one. Only a person asks for
    this; the app never merges by guess. Refuses when both places have an inside
    place of the same name: merge those first."""
    source = db.get(models.Place, place_id)
    target = db.get(models.Place, payload.into_id)
    if not source or not target:
        raise HTTPException(404, "Place not found")
    if source.id == target.id:
        raise HTTPException(422, "Pick a different place to merge into.")
    if source.kind != target.kind:
        raise HTTPException(422, f"Only places of the same kind can be merged: this is a {source.kind}, the other is a {target.kind}.")

    inside = db.query(models.Place).filter(models.Place.parent_id == source.id).all()
    for child in inside:
        twin = _clash(db, child.kind, target.id, child.name)
        if twin is not None:
            raise HTTPException(
                409,
                f"Both have a {child.kind} called “{child.name}”. Merge those two first, then merge “{source.name}”.",
            )

    direct = db.query(models.Instrument).filter(models.Instrument.place_id == source.id).all()
    for child in inside:
        child.parent_id = target.id
    for instrument in direct:
        instrument.place = target
    db.flush()
    db.expire_all()
    target = db.get(models.Place, target.id)
    moved = refresh_instrument_text(db, target)
    db.flush()
    db.delete(db.get(models.Place, source.id))
    db.commit()
    return schemas.PlaceMergeOut(moved_instruments=len(direct), moved_places=len(inside), into=target.name)
