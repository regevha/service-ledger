"""The shared password in front of the app: who gets in, what stays open, and
that a refused request changes nothing."""
from __future__ import annotations

import base64
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.main import app
from app.shared_password import SharedPasswordMiddleware

PASSWORD = "correct horse: battery"  # a colon inside it must survive


def _basic(user: str, password: str) -> dict:
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture
def gated(monkeypatch):
    monkeypatch.setattr(get_settings(), "shared_password", PASSWORD)


@pytest.fixture
def anon():
    with TestClient(app) as c:
        yield c


def test_without_a_configured_password_everything_is_open(anon):
    assert anon.get("/instruments").status_code == 200
    assert anon.get("/health").status_code == 200


def test_no_credentials_is_a_401_that_asks_for_a_password(anon, gated):
    r = anon.get("/instruments")
    assert r.status_code == 401
    assert r.headers["www-authenticate"].startswith("Basic")
    assert r.json() == {"detail": "A password is required."}


def test_the_right_password_gets_in_with_any_user_name(anon, gated):
    for user in ("tester", "", "someone else"):
        assert anon.get("/instruments", headers=_basic(user, PASSWORD)).status_code == 200


@pytest.mark.parametrize("password", ["wrong", PASSWORD + "x", PASSWORD[:-1], PASSWORD.upper(), ""])
def test_a_wrong_password_is_refused(anon, gated, password):
    assert anon.get("/instruments", headers=_basic("tester", password)).status_code == 401


@pytest.mark.parametrize(
    "header",
    [
        "Bearer abc",
        "Basic !!!not-base64!!!",
        "Basic " + base64.b64encode(b"no-colon-at-all").decode(),
        "Basic " + base64.b64encode(b"\xff\xfe:\xff").decode(),
        "Basic",
        "",
    ],
)
def test_a_malformed_authorization_header_is_refused_not_a_crash(anon, gated, header):
    assert anon.get("/instruments", headers={"Authorization": header}).status_code == 401


def test_a_non_ascii_password_works(anon, monkeypatch):
    monkeypatch.setattr(get_settings(), "shared_password", "סיסמה-ארוכה-מאוד")
    assert anon.get("/instruments", headers=_basic("u", "סיסמה-ארוכה-מאוד")).status_code == 200


def test_health_stays_open_and_leaks_nothing(anon, gated):
    r = anon.get("/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


@pytest.mark.parametrize("path", ["/docs", "/openapi.json", "/config", "/reports", "/instruments"])
def test_everything_else_is_behind_the_password(anon, gated, path):
    assert anon.get(path).status_code == 401
    assert anon.get(path, headers=_basic("u", PASSWORD)).status_code != 401


def test_a_refused_write_changes_nothing(anon, gated):
    before = anon.get("/instruments", headers=_basic("u", PASSWORD)).json()
    body = {"name": "Intruder", "model": "X", "serial_number": "ZZ999999", "manufacturer": "Y", "instrument_type": "facs"}
    assert anon.post("/instruments", json=body).status_code == 401
    assert anon.delete(f"/instruments/{before[0]['id']}").status_code == 401
    assert anon.get("/instruments", headers=_basic("u", PASSWORD)).json() == before


def test_a_preflight_without_the_password_is_also_refused(anon, gated):
    r = anon.options("/instruments", headers={"Origin": "http://x", "Access-Control-Request-Method": "GET"})
    assert r.status_code == 401


def test_a_wrong_attempt_is_logged_without_the_password(anon, gated, caplog):
    caplog.set_level(logging.WARNING, logger="app.shared_password")
    anon.get("/instruments", headers=_basic("u", "guess-number-one"))
    text = " ".join(rec.getMessage() for rec in caplog.records)
    assert "Wrong shared password" in text and "/instruments" in text
    assert "guess-number-one" not in text
    # no credentials at all is just the browser's first request, not a guess
    caplog.clear()
    anon.get("/instruments")
    assert not caplog.records


def test_the_gate_applies_to_any_app_it_wraps(monkeypatch):
    monkeypatch.setattr(get_settings(), "shared_password", PASSWORD)
    small = FastAPI()
    small.add_middleware(SharedPasswordMiddleware)

    @small.get("/x")
    def x():
        return {"ok": True}

    c = TestClient(small)
    assert c.get("/x").status_code == 401
    assert c.get("/x", headers=_basic("u", PASSWORD)).json() == {"ok": True}


def test_a_short_password_is_refused_at_startup():
    with pytest.raises(ValidationError, match="at least 12"):
        Settings(_env_file=None, shared_password="short")
    with pytest.raises(ValidationError, match="at least 12"):
        Settings(_env_file=None, shared_password="x" * 11)
    assert Settings(_env_file=None, shared_password="x" * 12).shared_password == "x" * 12
    assert Settings(_env_file=None).shared_password == ""
