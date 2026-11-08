"""Replays the evaluation set (app/tools/search_eval_cases.py) with a stub in place of the model."""
from __future__ import annotations

import pytest

from app.services import report_query_model as m
from app.tools.search_eval_cases import CASES, KNOWN, TODAY
from tests.test_report_query_model import FakeClient


@pytest.fixture(autouse=True)
def model_on(monkeypatch):
    monkeypatch.setattr(m.settings, "use_live_claude", True)
    monkeypatch.setattr(m.settings, "search_model_enabled", True)
    monkeypatch.setattr(m.settings, "anthropic_api_key", "sk-ant-test-key")
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 0)


@pytest.mark.parametrize("case", CASES, ids=[c["question"][:50] for c in CASES])
def test_case(case, monkeypatch):
    fake = FakeClient(case["model"])
    monkeypatch.setattr(m, "_get_client", lambda: fake)
    out = m.parse(case["question"], KNOWN, TODAY)
    assert out.filters == case["filters"]
    assert out.notes == case["notes"]
    if case["model"] is None:
        assert fake.calls == [], "the rules alone should have been enough"
        assert out.source == "rules"
    else:
        assert len(fake.calls) == 1, "the rules leave words over, so the model should be asked once"
        assert out.source == "ai"


def test_the_set_covers_each_kind_of_case():
    rules_only = [c for c in CASES if c["model"] is None]
    needs_model = [c for c in CASES if c["model"] is not None]
    assert len(CASES) >= 45 and len(rules_only) >= 25 and len(needs_model) >= 15
    assert any(c["notes"] for c in CASES)
