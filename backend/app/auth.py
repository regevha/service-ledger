"""Sign-in and role checks.

Who may do what is decided in ONE place, `required_role`, from the request's
method and route — not scattered across handlers — so a new endpoint is
protected by default (any signed-in user can read, a technician can write,
an admin can delete) and tests/test_auth_policy.py fails until a new route is
added to its expected table.

Passwords are hashed with scrypt from the standard library (a per-user salt,
no extra dependency). A session is a random token in an HttpOnly,
SameSite=Lax cookie — the cookie rides along on the plain links the app
uses for scan images, PDFs and CSV export, which a bearer header could not —
and only the token's SHA-256 is stored, so sessions can be revoked
(sign-out, password change, deactivation).
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.db import get_db
from app.models import UserRole

MIN_PASSWORD_LENGTH = 8
_ROLE_RANK = {UserRole.viewer: 0, UserRole.technician: 1, UserRole.admin: 2}

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**14, 8, 1


# ---------- passwords ----------


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        candidate = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(candidate, bytes.fromhex(digest))
    except (ValueError, TypeError):
        return False


# Verified against when the username is unknown, so a miss costs the same as a
# wrong password and does not reveal which usernames exist.
_DUMMY_HASH = hash_password("not-a-real-password")


def authenticate(db: Session, username: str, password: str) -> models.User | None:
    user = db.query(models.User).filter(models.User.username == username.strip().lower()).one_or_none()
    ok = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    return user if user and ok and user.is_active else None


# ---------- sessions ----------


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(db: Session, user: models.User) -> str:
    """Returns the cookie value; only its hash is stored."""
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=get_settings().session_ttl_hours)
    db.add(models.UserSession(token_hash=_hash_token(token), user_id=user.id, expires_at=expires))
    db.commit()
    return token


def end_session(db: Session, token: str | None) -> None:
    if token:
        db.query(models.UserSession).filter(models.UserSession.token_hash == _hash_token(token)).delete()
        db.commit()


def end_all_sessions(db: Session, user_id) -> None:
    db.query(models.UserSession).filter(models.UserSession.user_id == user_id).delete()


def user_for_token(db: Session, token: str | None) -> models.User | None:
    if not token:
        return None
    row = db.get(models.UserSession, _hash_token(token))
    if row is None:
        return None
    if row.expires_at <= datetime.now(timezone.utc):
        db.delete(row)
        db.commit()
        return None
    return row.user if row.user.is_active else None


# ---------- who may do what ----------

# Open to everyone, signed in or not: liveness, the two confidence thresholds
# the login screen's app shell reads, and signing in/out themselves.
PUBLIC = {("GET", "/health"), ("GET", "/config"), ("POST", "/auth/login"), ("POST", "/auth/logout")}


def required_role(method: str, path: str) -> UserRole | None:
    """The least-privileged role allowed to call `method path`, or None when
    the endpoint is public. `path` is the route template ("/reports/{report_id}")."""
    method = method.upper()
    if (method, path) in PUBLIC:
        return None
    if path == "/users" or path.startswith("/users/"):
        return UserRole.admin
    # A saved filter is a shared convenience, not a record: a technician may
    # remove one (the proposal narrows this to "the person who saved it, and
    # admins" once filters carry a creator; until then any technician can).
    if method == "DELETE" and path.startswith("/saved-report-filters/"):
        return UserRole.technician
    if method == "DELETE":
        return UserRole.admin
    if method in ("POST", "PATCH", "PUT"):
        # The fleet and the templates are admin-managed; everything else a
        # write touches (reports, uploads, classify/extract, finalize) is
        # a technician's job.
        # Adding an instrument is the one fleet change a technician makes: the
        # intake screen offers it when a document comes from a maker that is
        # not in the fleet (decision 2026-10-15). Editing and deleting stay admin.
        if method == "POST" and path == "/instruments":
            return UserRole.technician
        if path == "/instruments" or path.startswith("/instruments/"):
            return UserRole.admin
        if path == "/instrument-types":
            return UserRole.admin
        if path == "/report-templates" or path.startswith("/report-templates/"):
            return UserRole.admin
        return UserRole.technician
    return UserRole.viewer


def has_role(user: models.User, needed: UserRole) -> bool:
    return _ROLE_RANK[user.role] >= _ROLE_RANK[needed]


def current_user(request: Request, db: Session = Depends(get_db)) -> models.User:
    user = user_for_token(db, request.cookies.get(get_settings().session_cookie_name))
    if user is None:
        raise HTTPException(401, "Sign in to continue.")
    return user


def enforce_policy(request: Request, db: Session = Depends(get_db)) -> None:
    """App-wide dependency: checks every request against `required_role`."""
    route = request.scope.get("route")
    path = getattr(route, "path", None)
    if path is None:
        return  # no route matched — the router answers 404/405 itself
    needed = required_role(request.method, path)
    if needed is None:
        return
    user = current_user(request, db)
    if not has_role(user, needed):
        raise HTTPException(403, f"This needs the {needed.value} role; you are signed in as {user.role.value}.")
    request.state.user = user
