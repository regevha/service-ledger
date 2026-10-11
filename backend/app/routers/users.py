import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.db import get_db

router = APIRouter(tags=["users"])

_NEED_ONE_ADMIN = "There must always be at least one active admin."


def _check_password(password: str) -> None:
    if len(password) < auth.MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"The password must be at least {auth.MIN_PASSWORD_LENGTH} characters.")


@router.get("/users", response_model=list[schemas.UserOut])
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).order_by(models.User.username).all()


@router.post("/users", response_model=schemas.UserOut, status_code=201)
def create_user(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    _check_password(payload.password)
    user = models.User(
        username=payload.username, password_hash=auth.hash_password(payload.password), role=payload.role
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f'The username "{payload.username}" is already taken.')
    db.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=schemas.UserOut)
def update_user(user_id: uuid.UUID, payload: schemas.UserUpdate, db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    provided = payload.model_fields_set
    for field in ("role", "is_active", "password"):
        if field in provided and getattr(payload, field) is None:
            raise HTTPException(422, f"{field} cannot be null — omit it to leave it unchanged.")

    new_role = payload.role if "role" in provided else user.role
    new_active = payload.is_active if "is_active" in provided else user.is_active
    stops_being_active_admin = user.role == models.UserRole.admin and user.is_active and not (
        new_role == models.UserRole.admin and new_active
    )
    if stops_being_active_admin:
        others = (
            db.query(models.User)
            .filter(models.User.role == models.UserRole.admin, models.User.is_active, models.User.id != user.id)
            .count()
        )
        if others == 0:
            raise HTTPException(409, _NEED_ONE_ADMIN)

    user.role = new_role
    user.is_active = new_active
    if "password" in provided:
        _check_password(payload.password)
        user.password_hash = auth.hash_password(payload.password)
    if "password" in provided or not new_active:
        auth.end_all_sessions(db, user.id)
    db.commit()
    db.refresh(user)
    return user
