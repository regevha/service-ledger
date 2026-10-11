from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app import auth, models, schemas
from app.config import get_settings
from app.db import get_db

router = APIRouter(tags=["auth"])


def _set_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


@router.post("/auth/login", response_model=schemas.UserOut)
def login(payload: schemas.LoginIn, response: Response, db: Session = Depends(get_db)):
    user = auth.authenticate(db, payload.username, payload.password)
    if user is None:
        # One message for "no such user", "wrong password" and "deactivated".
        raise HTTPException(401, "Wrong username or password.")
    _set_cookie(response, auth.create_session(db, user))
    return user


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    settings = get_settings()
    auth.end_session(db, request.cookies.get(settings.session_cookie_name))
    response.delete_cookie(settings.session_cookie_name, path="/")


@router.get("/auth/me", response_model=schemas.UserOut)
def me(user: models.User = Depends(auth.current_user)):
    return user
