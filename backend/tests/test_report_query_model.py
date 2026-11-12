"""Model-backed search: the rules go first, the model only fills gaps, and any failure falls back to the rules."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import models
from app.services import report_query_model as m
from app.services.errors import SearchError
from app.services.report_query_parse import Known
from app.tools.search_eval_cases import KNOWN, TODAY


class FakeClient:
    """Stands in for the Anthropic client: records the request, answers with a canned tool call."""

    def __init__(self, tool_input=None, *, raises=None, stop_reason="tool_use", blocks=None):
        self.tool_input = tool_input if tool_input is not None else {}
        self.raises = raises
        self.stop_reason = stop_reason
        self.blocks = blocks
        self.calls: list[dict] = []
        self.options: dict = {}
        self.messages = SimpleNamespace(create=self._create)

    def with_options(self, **options):
        self.options = options
        return self

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises:
            raise self.raises
        content = self.blocks if self.blocks is not None else [SimpleNamespace(type="tool_use", input=self.tool_input)]
        return SimpleNamespace(content=content, stop_reason=self.stop_reason, usage=SimpleNamespace(input_tokens=1200, output_tokens=60))


@pytest.fixture(autouse=True)
def model_on(monkeypatch):
    monkeypatch.setattr(m.settings, "use_live_claude", True)
    monkeypatch.setattr(m.settings, "search_model_enabled", True)
    monkeypatch.setattr(m.settings, "anthropic_api_key", "sk-ant-test-key")
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 500)
    m.reset_cap_for_tests()


def use(monkeypatch, fake: FakeClient) -> FakeClient:
    monkeypatch.setattr(m, "_get_client", lambda: fake)
    return fake


def ask(text: str):
    return m.parse(text, KNOWN, TODAY)


def test_rules_only_question_makes_no_call(monkeypatch):
    fake = use(monkeypatch, FakeClient())
    out = ask("repairs of the FACSAria III last month")
    assert fake.calls == [] and out.source == "rules"


def test_no_words_left_over_makes_no_call(monkeypatch):
    fake = use(monkeypatch, FakeClient())
    assert ask("show me all reports").source == "rules"
    assert fake.calls == []


@pytest.mark.parametrize("flag", ["use_live_claude", "search_model_enabled"])
def test_switched_off_makes_no_call(monkeypatch, flag):
    monkeypatch.setattr(m.settings, flag, False)
    fake = use(monkeypatch, FakeClient({"text": "pmt"}))
    out = ask("reports mentioning a PMT")
    assert fake.calls == [] and out.source == "rules" and out.filters == {"q": "pmt"}


def test_no_api_key_makes_no_call(monkeypatch):
    monkeypatch.setattr(m.settings, "anthropic_api_key", "")
    fake = use(monkeypatch, FakeClient({"text": "pmt"}))
    assert ask("reports mentioning a PMT").source == "rules"
    assert fake.calls == []


def test_model_fills_gaps_and_marks_the_source(monkeypatch):
    use(monkeypatch, FakeClient({"instrument_model": "FACSDiscover S8", "text": ""}))
    out = ask("S8 installation reports")
    assert out.source == "ai"
    assert out.filters == {"report_type": "installation_upgrade", "model_id": "m-s8"}
    assert {"key": "model_id", "label": "Model: FACSDiscover S8"} in out.understood


def test_model_never_overrules_what_the_rules_found(monkeypatch):
    use(monkeypatch, FakeClient({"report_type": "repair", "status": "finalized", "instrument_model": "LSRFortessa",
                                 "date_from": "2020-01-01", "date_to": "2020-12-31", "text": "laser"}))
    out = ask("preventive maintenance of the Aurora in 2025 laser")
    assert out.filters["report_type"] == "preventive_maintenance"
    assert out.filters["model_id"] == "m-aur"
    assert (out.filters["date_from"], out.filters["date_to"]) == ("2025-01-01", "2025-12-31")
    assert out.filters["status"] == "finalized"  # the rules set no status, so this gap is filled


def test_request_sends_the_question_and_model_and_place_names_but_no_serials(monkeypatch):
    fake = use(monkeypatch, FakeClient({"text": "pmt"}))
    ask("reports mentioning a PMT at Hadassah serial P69200123")
    (call,) = fake.calls
    sent = repr(call)
    assert "FACSAria III" in sent and "LSRFortessa" in sent
    assert "Hadassah" in call["system"][0]["text"] and "Bar-Ilan University" in call["system"][0]["text"]
    # Serial numbers from the database are never listed; one the person typed is only in their own question.
    assert "R1-0412" not in sent and "P69200123" not in call["system"][0]["text"]
    assert call["model"] == m.settings.anthropic_search_model
    assert call["tool_choice"] == {"type": "tool", "name": "set_report_filters"}
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert call["max_tokens"] == m.settings.search_model_max_tokens


def test_request_tells_the_model_what_the_rules_already_understood(monkeypatch):
    fake = use(monkeypatch, FakeClient({"text": "", "not_supported": []}))
    ask("repairs at Bar-Ilan University involving the laser")
    content = fake.calls[0]["messages"][0]["content"]
    assert "Already understood" in content and "Repair" in content and "Place: Bar-Ilan University" in content


def test_a_place_or_model_name_is_not_taken_as_a_technician(monkeypatch):
    use(monkeypatch, FakeClient({"technician": "Hadassah", "text": ""}))
    assert "technician" not in ask("something about hadassah, more words").filters
    use(monkeypatch, FakeClient({"technician": "Aurora", "text": ""}))
    assert "technician" not in ask("hello there general").filters
    use(monkeypatch, FakeClient({"technician": "Dana Levi", "text": ""}))
    assert ask("hello there general").filters["technician"] == "dana levi"


def test_a_short_place_name_is_mapped_to_the_full_one(monkeypatch):
    use(monkeypatch, FakeClient({"place": "Bar-Ilan", "text": ""}))
    out = ask("what happened at the Bar-Ilan lab")
    assert out.filters["place_id"] == "p-bar" and {"key": "place_id", "label": "Place: Bar-Ilan University"} in out.understood
    use(monkeypatch, FakeClient({"place": "Hadassah", "text": ""}))
    assert ask("hello there general").filters["place_id"] == "p-had"


def test_unknown_or_ambiguous_places_are_dropped_and_rules_win(monkeypatch):
    use(monkeypatch, FakeClient({"place": "Hogwarts", "text": ""}))
    assert "place_id" not in ask("hello there general").filters
    use(monkeypatch, FakeClient({"place": "Hospital", "text": ""}))
    two = Known(models=[], places=[("a", "Hadassah Hospital"), ("b", "Sheba Hospital")])
    out = m.parse("hello there general", two, TODAY)
    assert "place_id" not in out.filters  # "hospital" fits two places: not guessed
    use(monkeypatch, FakeClient({"place": "Hadassah", "text": ""}))
    assert ask("repairs at Bar-Ilan University hello").filters["place_id"] == "p-bar"  # the rules' place stays


def test_short_timeout_and_no_retry(monkeypatch):
    fake = use(monkeypatch, FakeClient({"text": "pmt"}))
    ask("reports mentioning a PMT")
    assert fake.options == {"timeout": m.settings.search_model_timeout_seconds, "max_retries": 0}


@pytest.mark.parametrize(
    "fake",
    [
        FakeClient(raises=RuntimeError("boom")),
        FakeClient(blocks=[SimpleNamespace(type="text", text="no tool")]),
        FakeClient({"text": "x"}, stop_reason="max_tokens"),
    ],
)
def test_any_failure_falls_back_to_the_rules(monkeypatch, fake):
    use(monkeypatch, fake)
    out = ask("reports mentioning a PMT")
    assert out.source == "rules_fallback" and out.filters == {"q": "pmt"}


def test_api_error_falls_back(monkeypatch):
    import anthropic
    import httpx

    err = anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))
    use(monkeypatch, FakeClient(raises=err))
    assert ask("reports mentioning a PMT").source == "rules_fallback"


def test_daily_cap(monkeypatch):
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 2)
    fake = use(monkeypatch, FakeClient({"text": "pmt"}))
    sources = [ask("reports mentioning a PMT").source for _ in range(3)]
    assert sources == ["ai", "ai", "rules_fallback"] and len(fake.calls) == 2


def test_cap_zero_means_no_limit(monkeypatch):
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 0)
    use(monkeypatch, FakeClient({"text": "pmt"}))
    assert all(ask("reports mentioning a PMT").source == "ai" for _ in range(5))


@pytest.mark.parametrize(
    "tool_input, expected",
    [
        ({"report_type": "delete_everything"}, {}),
        ({"status": "all"}, {}),
        ({"date_from": "yesterday"}, {}),
        ({"date_from": "2026-13-45"}, {}),
        ({"date_from": "2026-05-01", "date_to": "2026-01-01"}, {}),
        ({"instrument_model": "Death Star"}, {}),
        ({"technician": "x'; drop table reports;--"}, {}),
        ({"report_type": ["repair"], "text": 5, "instrument_model": None}, {}),
        ({"instrument_model": "facs aria iii"}, {"model_id": "m-aria"}),
        ({"date_to": "2026-05-01"}, {"date_to": "2026-05-01"}),
    ],
)
def test_every_value_is_checked(monkeypatch, tool_input, expected):
    use(monkeypatch, FakeClient(tool_input))
    out = ask("hello there general")
    assert {k: v for k, v in out.filters.items() if k != "q"} == expected


def test_text_that_repeats_a_type_already_set_is_dropped(monkeypatch):
    use(monkeypatch, FakeClient({"text": "broken", "not_supported": []}))
    out = ask("broken instruments nobody reviewed")
    assert out.filters["report_type"] == "repair" and "q" not in out.filters
    use(monkeypatch, FakeClient({"text": "broken laser", "not_supported": []}))
    assert ask("broken instruments nobody reviewed").filters["q"] == "laser"


def test_text_and_notes_are_cleaned_and_limited(monkeypatch):
    use(monkeypatch, FakeClient({"text": "  Laser   DELAY " + "x" * 300, "not_supported": ["a"] * 9 + [123, "b" * 500]}))
    out = ask("hello there general")
    assert out.filters["q"].startswith("laser delay x") and len(out.filters["q"]) <= 100
    assert len(out.notes) <= 5 and all(len(n) <= 80 for n in out.notes)


def test_tool_input_that_is_not_an_object_falls_back(monkeypatch):
    use(monkeypatch, FakeClient(["repair"]))
    assert ask("reports mentioning a PMT").source == "rules_fallback"


def test_prompt_review_stop_falls_back_instead_of_breaking_the_request(monkeypatch):
    monkeypatch.setattr("app.services.claude_client.settings.view_prompts", True)
    use(monkeypatch, FakeClient({"text": "pmt"}))
    assert ask("reports mentioning a PMT").source == "rules_fallback"


def test_search_error_is_a_live_claude_error():
    from app.services.errors import LiveClaudeError

    assert issubclass(SearchError, LiveClaudeError)


def test_endpoint_reports_source_and_notes(client, monkeypatch):
    r = client.post("/reports/parse-search", json={"text": "repairs last month"})
    assert r.status_code == 200 and r.json()["source"] == "rules" and r.json()["notes"] == []
    use(monkeypatch, FakeClient({"not_supported": ["overdue"], "text": ""}))
    r = client.post("/reports/parse-search", json={"text": "which instruments are overdue for PM?"})
    body = r.json()
    assert body["source"] == "ai" and body["notes"] == ["overdue"]
    assert body["filters"] == {"report_type": "preventive_maintenance"}


def test_endpoint_survives_a_failing_model(client, monkeypatch):
    use(monkeypatch, FakeClient(raises=RuntimeError("down")))
    r = client.post("/reports/parse-search", json={"text": "reports mentioning a PMT"})
    assert r.status_code == 200 and r.json()["source"] == "rules_fallback" and r.json()["filters"] == {"q": "pmt"}


def test_a_note_that_only_repeats_a_filter_is_dropped():
    from app.services.report_query_model import merge
    from app.services.report_query_parse import parse_search
    from app.tools.search_eval_cases import KNOWN, TODAY

    rules = parse_search("broken instruments that nobody has reviewed", KNOWN, TODAY)
    out = merge(rules, {"text": "", "not_supported": ["reports nobody has reviewed", "overdue"]}, KNOWN)
    assert out.filters["status"] == "extracted"
    assert out.notes == ["overdue"]


def test_cap_is_counted_in_the_database_and_survives_a_restart(seeded, monkeypatch):
    """The counter used to live in memory: a restart or a second replica started it at zero."""
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 2)
    assert m._under_daily_cap(seeded) and m._under_daily_cap(seeded)
    m.reset_cap_for_tests()  # what a restart did to the old counter; the database does not forget
    assert m._under_daily_cap(seeded) is False
    assert seeded.query(models.SearchModelCall).count() == 2


def test_calls_older_than_a_day_do_not_count_and_old_rows_are_pruned(seeded, monkeypatch):
    from datetime import datetime, timedelta, timezone

    monkeypatch.setattr(m.settings, "search_model_daily_cap", 1)
    now = datetime.now(timezone.utc)
    seeded.add_all([
        models.SearchModelCall(called_at=now - timedelta(hours=25)),
        models.SearchModelCall(called_at=now - timedelta(days=8)),
    ])
    seeded.commit()
    assert m._under_daily_cap(seeded) is True  # the 25 hour old call is outside the window
    assert m._under_daily_cap(seeded) is False
    assert seeded.query(models.SearchModelCall).count() == 2  # the 8 day old row was pruned


def test_a_zero_cap_means_no_limit_and_writes_nothing(seeded, monkeypatch):
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 0)
    assert all(m._under_daily_cap(seeded) for _ in range(5))
    assert seeded.query(models.SearchModelCall).count() == 0


def test_parse_search_endpoint_stops_calling_the_model_at_the_cap(client, monkeypatch):
    fake = use(monkeypatch, FakeClient(tool_input={}))
    monkeypatch.setattr(m.settings, "search_model_daily_cap", 1)
    asked = {"text": "which instruments are overdue for PM?"}
    first = client.post("/reports/parse-search", json=asked).json()
    second = client.post("/reports/parse-search", json=asked).json()
    assert len(fake.calls) == 1
    assert second["source"] == "rules_fallback"
    assert first["source"] != "rules_fallback"
