"""Defaults in Settings that carry a user decision (docs/PLAN.md)."""

from __future__ import annotations

import pytest

from app.config import Settings


def test_job_retention_defaults_to_90_days(monkeypatch: pytest.MonkeyPatch) -> None:
    # D-4 / D-10: finished jobs are kept 90 days unless JOB_RETENTION_DAYS says otherwise.
    monkeypatch.delenv("JOB_RETENTION_DAYS", raising=False)
    assert Settings(_env_file=None).job_retention_days == 90


def test_job_retention_can_be_overridden(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JOB_RETENTION_DAYS", "30")
    assert Settings(_env_file=None).job_retention_days == 30
