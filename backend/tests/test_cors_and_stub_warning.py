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


def test_stub_warning_describes_what_stub_extraction_really_does():
    # The product default (the test suite switches it off in conftest, so it is set here): extraction
    # reads the PDF's text layer, so the warning must not say values are invented.
    text_mode = _settings(use_live_claude=False, stub_extract_from_text=True).stub_mode_warning
    assert "text layer" in text_mode
    assert "invented" not in text_mode
    assert "Classification is a stand-in" in text_mode
    # With the text reading off, extraction does invent values and the warning says so.
    invented = _settings(use_live_claude=False, stub_extract_from_text=False).stub_mode_warning
    assert "invented demo values" in invented


def test_api_startup_logs_the_stub_warning(caplog):
    with caplog.at_level(logging.WARNING, logger="app.main"):
        with TestClient(app):
            pass
    assert any("USE_LIVE_CLAUDE is off" in r.getMessage() for r in caplog.records)
