"""Create (or reset) a sign-in from the command line — the way to make the
first admin on a database that has none, or to recover when every admin is
locked out:

    python -m app.create_user dana admin
    python -m app.create_user sam technician --password 'a long password'

Without --password it asks for one (not echoed). If the username exists, its
role and password are replaced and its sessions ended.
"""
from __future__ import annotations

import argparse
import getpass
import sys

from app import auth, models
from app.db import SessionLocal


def upsert_user(db, username: str, password: str, role: models.UserRole) -> models.User:
    if len(password) < auth.MIN_PASSWORD_LENGTH:
        raise ValueError(f"The password must be at least {auth.MIN_PASSWORD_LENGTH} characters.")
    username = username.strip().lower()
    if not username:
        raise ValueError("The username cannot be blank.")
    user = db.query(models.User).filter(models.User.username == username).one_or_none()
    if user is None:
        user = models.User(username=username, password_hash=auth.hash_password(password), role=role)
        db.add(user)
    else:
        user.password_hash = auth.hash_password(password)
        user.role = role
        user.is_active = True
        auth.end_all_sessions(db, user.id)
    db.commit()
    db.refresh(user)
    return user


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("username")
    parser.add_argument("role", choices=[r.value for r in models.UserRole])
    parser.add_argument("--password")
    args = parser.parse_args(argv)
    password = args.password or getpass.getpass("Password: ")
    try:
        with SessionLocal() as db:
            user = upsert_user(db, args.username, password, models.UserRole(args.role))
    except ValueError as e:
        print(e, file=sys.stderr)
        return 1
    print(f"{user.username} can now sign in as {user.role.value}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
