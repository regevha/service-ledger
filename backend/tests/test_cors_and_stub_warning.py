"""CORS is open only in development; stub mode is announced at startup."""
import logging

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app


def _settings(**kw):
    return Settings(_env_file=None, **kw)


def test_development_allows_every_origin():
    assert _settings().cors_origins == ["*"]


def test_deployed_allows_no_other_origin_by_default(tmp_path):
    assert _settings(frontend_dist_dir=str(tmp_path)).cors_origins == []


def test_deployed_allows_only_the_listed_origins(tmp_path):
    s = _settings(frontend_dist_dir=str(tmp_path), cors_allowed_origins=" https://a.example , https://b.example,,*")
    assert s.cors_origins == ["https://a.example", "https://b.example"]


def test_stub_mode_has_a_warning_and_live_mode_does_not():
    assert "NOT read by the model" in _settings(use_live_claude=False).stub_mode_warning
    assert _settings(use_live_claude=True).stub_mode_warning is None


def test_api_startup_logs_the_stub_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="app.main"):
        with TestClient(app):
            pass
    assert any("USE_LIVE_CLAUDE is off" in r.getMessage() for r in caplog.records)
