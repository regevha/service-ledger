"""Serving the built frontend from the API, so a deployment is one address."""
from __future__ import annotations

import base64

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import get_settings
from app.frontend_static import mount_frontend
from app.shared_password import SharedPasswordMiddleware


@pytest.fixture
def dist(tmp_path):
    (tmp_path / "index.html").write_text("<html>ServiceLedger page</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('hi')")
    (tmp_path / "reports").write_text("a file that must NOT shadow the API route")
    return tmp_path


def _app(dist):
    small = FastAPI()

    @small.get("/reports")
    def reports():
        return {"api": True}

    mount_frontend(small, str(dist))
    return small


def test_the_page_and_its_files_are_served(dist):
    c = TestClient(_app(dist))
    assert "ServiceLedger page" in c.get("/").text
    r = c.get("/assets/app.js")
    assert r.status_code == 200 and "console.log" in r.text


def test_an_api_route_wins_over_a_file_of_the_same_name(dist):
    assert TestClient(_app(dist)).get("/reports").json() == {"api": True}


def test_an_unknown_path_is_a_plain_404(dist):
    assert TestClient(_app(dist)).get("/nope").status_code == 404


def test_a_folder_without_index_html_stops_startup_with_a_clear_message(tmp_path):
    with pytest.raises(RuntimeError, match="npm run build"):
        mount_frontend(FastAPI(), str(tmp_path))


def test_the_password_covers_the_page_too(dist, monkeypatch):
    monkeypatch.setattr(get_settings(), "shared_password", "a-long-shared-password")
    small = _app(dist)
    small.add_middleware(SharedPasswordMiddleware)
    c = TestClient(small)
    assert c.get("/").status_code == 401
    assert c.get("/assets/app.js").status_code == 401
    token = base64.b64encode(b"u:a-long-shared-password").decode()
    assert c.get("/", headers={"Authorization": f"Basic {token}"}).status_code == 200
