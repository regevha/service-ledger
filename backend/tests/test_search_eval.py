"""Replays the evaluation set (app/tools/search_eval_cases.py) with a stub in place of the model."""
from __future__ import annotations

import pytest

from app.services import report_query_model as m
from app.tools.search_eval_cases import CASES, GAPS, KNOWN, TODAY
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


@pytest.mark.xfail(strict=True, reason="a known gap in the rules; when it passes, move the case up into CASES")
@pytest.mark.parametrize("case", GAPS, ids=[c["question"][:50] for c in GAPS])
def test_known_gap(case, monkeypatch):
    fake = FakeClient(case["model"])
    monkeypatch.setattr(m, "_get_client", lambda: fake)
    out = m.parse(case["question"], KNOWN, TODAY)
    assert out.filters == case["filters"]
    assert out.notes == case["notes"]


def test_the_set_covers_each_kind_of_case():
    rules_only = [c for c in CASES if c["model"] is None]
    needs_model = [c for c in CASES if c["model"] is not None]
    assert len(CASES) >= 100 and len(rules_only) >= 40 and len(needs_model) >= 50
    assert any(c["notes"] for c in CASES)


@pytest.mark.parametrize(
    "answer",
    [
        {"field": "humidity", "op": "gt", "value": 40},  # not a field that exists
        {"field": "laser_delay", "op": "above", "value": 40},  # not a comparison we know
        {"field": "laser_delay", "op": "gt", "value": "forty"},  # not a number
        {"field": "laser_delay", "op": "gt", "value": True},  # a boolean is not a number
        {"field": "laser_delay", "op": "gt", "value": float("inf")},
        {"field": "laser_delay", "op": "gt"},  # no value
        {"op": "gt", "value": 3},  # no field
    ],
)
def test_a_bad_field_condition_is_dropped(answer, monkeypatch):
    fake = FakeClient({**answer, "text": ""})
    monkeypatch.setattr(m, "_get_client", lambda: fake)
    out = m.parse("laser delay is quite big", KNOWN, TODAY)  # the rules cannot read this one, so the model is asked
    assert fake.calls
    assert not {"number_field", "number_op", "number_value"} & set(out.filters)


def test_a_field_name_is_matched_ignoring_case(monkeypatch):
    fake = FakeClient({"field": "Laser_Delay", "op": "gt", "value": 29, "text": ""})
    monkeypatch.setattr(m, "_get_client", lambda: fake)
    out = m.parse("laser delay is quite big", KNOWN, TODAY)
    assert out.filters == {"number_field": "laser_delay", "number_op": "gt", "number_value": "29"}
    assert out.understood == [{"key": "field", "label": "Laser delay above 29"}]
