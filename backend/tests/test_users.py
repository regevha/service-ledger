"""The admin-only /users API and the `create_user` command."""
from __future__ import annotations

import pytest

from app import auth, main, models
from app.config import get_settings
from app.create_user import main as create_user_main, upsert_user
from app.models import UserRole
from tests.conftest import PASSWORD, TestSessionLocal


def _create(client, username="sam", role="technician", password=PASSWORD):
    return client.post("/users", json={"username": username, "password": password, "role": role})


def test_an_admin_creates_a_user_who_can_then_sign_in(client, anon_client):
    created = _create(client, " Sam ", "viewer")

    assert created.status_code == 201
    assert created.json()["username"] == "sam" and created.json()["role"] == "viewer"
    assert "password" not in created.text
    assert anon_client.post("/auth/login", json={"username": "sam", "password": PASSWORD}).status_code == 200


def test_usernames_are_unique(client):
    assert _create(client, "sam").status_code == 201
    duplicate = _create(client, "SAM")
    assert duplicate.status_code == 409 and "already taken" in duplicate.json()["detail"]


def test_a_short_password_or_blank_username_is_refused(client):
    short = _create(client, password="short")
    assert short.status_code == 422 and "at least 8" in short.json()["detail"]
    assert _create(client, username="   ").status_code == 422
    assert _create(client, role="superuser").status_code == 422


def test_listing_users(client):
    _create(client, "zed")
    _create(client, "amy")
    names = [u["username"] for u in client.get("/users").json()]
    assert names == sorted(names) and {"amy", "zed"} <= set(names)


def test_changing_a_password_signs_that_user_out_everywhere(client, client_as):
    sam = client_as("technician", "sam")
    assert sam.get("/auth/me").status_code == 200
    sam_id = next(u["id"] for u in client.get("/users").json() if u["username"] == "sam")

    assert client.patch(f"/users/{sam_id}", json={"password": "a brand new secret"}).status_code == 200

    assert sam.get("/auth/me").status_code == 401
    assert sam.post("/auth/login", json={"username": "sam", "password": PASSWORD}).status_code == 401
    assert sam.post("/auth/login", json={"username": "sam", "password": "a brand new secret"}).status_code == 200


def test_deactivating_a_user_ends_their_sessions(client, client_as):
    sam = client_as("technician", "sam")
    sam_id = next(u["id"] for u in client.get("/users").json() if u["username"] == "sam")

    assert client.patch(f"/users/{sam_id}", json={"is_active": False}).json()["is_active"] is False
    assert sam.get("/auth/me").status_code == 401

    client.patch(f"/users/{sam_id}", json={"is_active": True})
    assert sam.post("/auth/login", json={"username": "sam", "password": PASSWORD}).status_code == 200


def test_the_last_active_admin_cannot_be_demoted_or_deactivated(client):
    me = next(u for u in client.get("/users").json() if u["role"] == "admin")

    demote = client.patch(f"/users/{me['id']}", json={"role": "viewer"})
    deactivate = client.patch(f"/users/{me['id']}", json={"is_active": False})

    assert demote.status_code == deactivate.status_code == 409
    assert "at least one active admin" in demote.json()["detail"]
    # With a second admin it is allowed.
    other = _create(client, "second", "admin").json()
    assert client.patch(f"/users/{me['id']}", json={"role": "viewer"}).status_code == 200


def test_demoting_an_admin_is_refused_when_the_only_other_admin_is_inactive(client):
    other = _create(client, "second", "admin").json()
    me = next(u for u in client.get("/users").json() if u["username"] == "admin-user")
    client.patch(f"/users/{other['id']}", json={"is_active": False})

    assert client.patch(f"/users/{me['id']}", json={"role": "technician"}).status_code == 409


def test_patching_a_non_admin_is_never_blocked_by_the_admin_rule(client):
    sam = _create(client, "sam", "technician").json()
    assert client.patch(f"/users/{sam['id']}", json={"role": "viewer"}).json()["role"] == "viewer"


def test_update_user_404_and_null_fields(client):
    import uuid

    assert client.patch(f"/users/{uuid.uuid4()}", json={"role": "viewer"}).status_code == 404
    sam = _create(client).json()
    assert client.patch(f"/users/{sam['id']}", json={"role": None}).status_code == 422
    assert client.patch(f"/users/{sam['id']}", json={"password": "short"}).status_code == 422


def test_only_admins_manage_users(client_as):
    for role in ("viewer", "technician"):
        c = client_as(role)
        assert c.get("/users").status_code == 403
        assert _create(c).status_code == 403


# ---------- python -m app.create_user ----------


def test_upsert_user_creates_then_resets_an_existing_user(db_session):
    user = upsert_user(db_session, " Kim ", PASSWORD, UserRole.viewer)
    assert user.username == "kim" and user.role == UserRole.viewer

    again = upsert_user(db_session, "kim", "another long password", UserRole.admin)
    assert again.id == user.id and again.role == UserRole.admin
    assert auth.authenticate(db_session, "kim", "another long password") is not None
    assert auth.authenticate(db_session, "kim", PASSWORD) is None


def test_upsert_user_rejects_a_weak_password_or_blank_name(db_session):
    with pytest.raises(ValueError):
        upsert_user(db_session, "kim", "short", UserRole.viewer)
    with pytest.raises(ValueError):
        upsert_user(db_session, "  ", PASSWORD, UserRole.viewer)


def test_the_command_line_creates_a_user(monkeypatch, capsys):
    monkeypatch.setattr("app.create_user.SessionLocal", TestSessionLocal)
    assert create_user_main(["lee", "technician", "--password", PASSWORD]) == 0
    assert "lee can now sign in as technician" in capsys.readouterr().out
    with TestSessionLocal() as db:
        assert db.query(models.User).one().role == UserRole.technician


def test_the_command_line_prompts_for_a_password_and_reports_a_weak_one(monkeypatch, capsys):
    monkeypatch.setattr("app.create_user.SessionLocal", TestSessionLocal)
    monkeypatch.setattr("getpass.getpass", lambda prompt: "short")
    assert create_user_main(["lee", "admin"]) == 1
    assert "at least 8" in capsys.readouterr().err


# ---------- the first admin ----------


def test_startup_creates_the_initial_admin_only_when_no_user_exists(db_session, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "initial_admin_username", "boss")
    monkeypatch.setattr(settings, "initial_admin_password", PASSWORD)

    main._seed_initial_admin(db_session)
    assert [(u.username, u.role) for u in db_session.query(models.User).all()] == [("boss", UserRole.admin)]

    db_session.query(models.User).delete()
    upsert_user(db_session, "someone", PASSWORD, UserRole.viewer)
    main._seed_initial_admin(db_session)
    assert [u.username for u in db_session.query(models.User).all()] == ["someone"]


def test_startup_creates_nobody_without_both_settings(db_session, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "initial_admin_username", "boss")
    monkeypatch.setattr(settings, "initial_admin_password", "")
    main._seed_initial_admin(db_session)
    assert db_session.query(models.User).count() == 0
