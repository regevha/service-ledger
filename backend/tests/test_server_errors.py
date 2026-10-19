"""An unexpected server error must reach the browser as a readable JSON 500
that the page is allowed to read. Found on 2026-10-19: a crash in
PUT /field-aliases showed on screen as "Could not reach the backend" because the
bare 500 had no CORS headers."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app


@pytest.fixture
def crashing_route():
    async def _boom():
        raise RuntimeError("deliberate test crash")

    app.add_api_route("/__test_crash", _boom, methods=["GET"])
    try:
        yield "/__test_crash"
    finally:
        app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != "/__test_crash"]


def test_an_unhandled_error_is_a_json_500_the_page_can_read(crashing_route):
    with TestClient(app, raise_server_exceptions=False) as c:
        resp = c.get(crashing_route, headers={"Origin": "http://localhost:5173"})
    assert resp.status_code == 500
    assert resp.headers["access-control-allow-origin"] == "*"
    assert "Something went wrong on the server" in resp.json()["detail"]
    assert "deliberate test crash" not in resp.text


def test_the_error_is_logged_with_the_route(crashing_route, caplog):
    with caplog.at_level("ERROR", logger="app.main"):
        with TestClient(app, raise_server_exceptions=False) as c:
            c.get(crashing_route)
    assert any("GET /__test_crash" in r.getMessage() for r in caplog.records)


def test_a_normal_error_is_unchanged(client):
    resp = client.get("/reports/00000000-0000-0000-0000-000000000000", headers={"Origin": "http://localhost:5173"})
    assert resp.status_code == 404
    assert "Something went wrong" not in resp.text


def test_with_an_origin_allowlist_only_listed_origins_are_echoed(crashing_route, monkeypatch):
    monkeypatch.setattr(main, "CORS_ORIGINS", ["http://good.example"])
    with TestClient(app, raise_server_exceptions=False) as c:
        good = c.get(crashing_route, headers={"Origin": "http://good.example"})
        bad = c.get(crashing_route, headers={"Origin": "http://evil.example"})
    assert good.headers["access-control-allow-origin"] == "http://good.example"
    assert good.headers["vary"] == "Origin"
    assert "access-control-allow-origin" not in bad.headers
