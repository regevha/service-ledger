"""Signing in and out: passwords, cookie, session lifetime and revocation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text

from app import auth, models
from app.config import get_settings
from app.models import UserRole
from tests.conftest import PASSWORD, TestSessionLocal


def _login(client, username="dana", password=PASSWORD):
    return client.post("/auth/login", json={"username": username, "password": password})


def _user(role="technician", username="dana"):
    from app.create_user import upsert_user

    with TestSessionLocal() as db:
        upsert_user(db, username, PASSWORD, UserRole(role))


def test_nothing_but_the_public_endpoints_works_without_signing_in(anon_client):
    for path in ("/reports", "/instruments", "/analytics/fleet", "/auth/me"):
        response = anon_client.get(path)
        assert response.status_code == 401, path
        assert "Sign in" in response.json()["detail"]


def test_login_sets_an_httponly_lax_session_cookie_and_returns_the_user(anon_client):
    _user("technician")

    response = _login(anon_client)

    assert response.status_code == 200
    assert response.json()["username"] == "dana"
    assert response.json()["role"] == "technician"
    assert "password" not in response.text
    cookie = response.headers["set-cookie"].lower()
    assert f"{get_settings().session_cookie_name}=" in cookie
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert anon_client.get("/auth/me").json()["username"] == "dana"


def test_the_username_is_case_and_space_insensitive(anon_client):
    _user()
    assert _login(anon_client, "  DANA ").status_code == 200


def test_a_wrong_password_unknown_user_and_deactivated_user_all_get_the_same_answer(anon_client, client):
    _user()
    wrong = _login(anon_client, password="nope-nope-nope")
    unknown = _login(anon_client, username="nobody")
    dana = next(u for u in client.get("/users").json() if u["username"] == "dana")
    client.patch(f"/users/{dana['id']}", json={"is_active": False})
    inactive = _login(anon_client)

    assert wrong.status_code == unknown.status_code == inactive.status_code == 401
    assert wrong.json() == unknown.json() == inactive.json() == {"detail": "Wrong username or password."}
    assert anon_client.get("/auth/me").status_code == 401  # no session was created


def test_logout_ends_the_session_server_side(anon_client):
    _user()
    _login(anon_client)
    token = anon_client.cookies.get(get_settings().session_cookie_name)

    assert anon_client.post("/auth/logout").status_code == 204

    assert anon_client.get("/auth/me").status_code == 401
    # The old cookie value no longer works even if replayed.
    anon_client.cookies.set(get_settings().session_cookie_name, token)
    assert anon_client.get("/auth/me").status_code == 401
    with TestSessionLocal() as db:
        assert db.query(models.UserSession).count() == 0


def test_logout_without_a_session_is_harmless(anon_client):
    assert anon_client.post("/auth/logout").status_code == 204


def test_a_garbage_cookie_is_not_a_session(anon_client):
    anon_client.cookies.set(get_settings().session_cookie_name, "not-a-real-token")
    assert anon_client.get("/reports").status_code == 401


def test_an_expired_session_is_refused_and_removed(anon_client):
    _user()
    _login(anon_client)
    with TestSessionLocal() as db:
        db.execute(text("UPDATE user_sessions SET expires_at = :t"), {"t": datetime.now(timezone.utc) - timedelta(seconds=1)})
        db.commit()

    assert anon_client.get("/auth/me").status_code == 401
    with TestSessionLocal() as db:
        assert db.query(models.UserSession).count() == 0


def test_only_a_hash_of_the_token_is_stored(anon_client):
    _user()
    _login(anon_client)
    token = anon_client.cookies.get(get_settings().session_cookie_name)
    with TestSessionLocal() as db:
        stored = db.query(models.UserSession).one().token_hash
    assert stored != token and token not in stored and len(stored) == 64


def test_passwords_are_salted_scrypt_hashes_that_verify():
    first, second = auth.hash_password("hunter2hunter2"), auth.hash_password("hunter2hunter2")
    assert first != second  # per-hash salt
    assert first.startswith("scrypt$") and "hunter2" not in first
    assert auth.verify_password("hunter2hunter2", first)
    assert not auth.verify_password("hunter2hunter3", first)


def test_verify_password_rejects_malformed_hashes():
    for stored in ("", "plaintext", "md5$1$2$3$aa$bb", "scrypt$x$y$z$zz$zz"):
        assert auth.verify_password("anything", stored) is False


def test_a_role_change_applies_to_the_next_request_without_signing_in_again(anon_client, client):
    _user("viewer")
    _login(anon_client)
    assert anon_client.post("/reports", json={}).status_code == 403
    dana = next(u for u in client.get("/users").json() if u["username"] == "dana")

    client.patch(f"/users/{dana['id']}", json={"role": "technician"})

    assert anon_client.post("/reports", json={}).status_code == 201


def test_roles_limit_what_each_user_can_do(client_as):
    viewer, technician, admin = client_as("viewer"), client_as("technician"), client_as("admin")

    assert viewer.get("/reports").status_code == 200
    assert viewer.post("/reports", json={}).status_code == 403

    report = technician.post("/reports", json={"technician_name": "t"}).json()
    assert technician.delete(f"/reports/{report['id']}").status_code == 403
    assert technician.post("/instruments", json={"name": "x", "model": "m", "serial_number": "s-1"}).status_code == 403

    assert admin.delete(f"/reports/{report['id']}").status_code == 204
    assert admin.post("/instruments", json={"name": "x", "model": "m", "serial_number": "s-1"}).status_code == 201


def test_a_user_deactivated_directly_in_the_database_loses_access_at_once(anon_client):
    _user()
    _login(anon_client)
    with TestSessionLocal() as db:
        db.query(models.User).update({"is_active": False})
        db.commit()
    assert anon_client.get("/auth/me").status_code == 401
