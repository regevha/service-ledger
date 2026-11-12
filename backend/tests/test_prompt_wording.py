"""The prompts: shape of the answer asked for, no real customer details in the
examples, and a cut-off answer refused."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import classification, extraction, translation
from app.services.classification_prompt import build_classify_prompt
from app.services.claude_client import raise_if_truncated
from app.services.errors import ClassificationError, ExtractionError
from app.services.report_query_model import _system_prompt as _search_system_prompt

REAL_DETAILS = ("SMX0457374", "Shachar", "MP6651580000057", "R6651580000057", "BE50173", "QSC26R006240", "SC26R006240")


def test_extract_prompt_describes_the_flat_answer_the_tool_takes():
    text = extraction._EXTRACT_PROMPT_HEADER
    assert "__confidence" in text
    assert "Do not nest" in text
    assert "tool schema below" not in text


@pytest.mark.parametrize(
    "text",
    [extraction._EXTRACT_PROMPT_HEADER, classification._CLASSIFY_BODY, translation._PROMPT],
)
def test_prompts_carry_no_real_identifiers_or_names(text):
    for detail in REAL_DETAILS:
        assert detail not in text


@pytest.mark.parametrize("error_cls", [ClassificationError, ExtractionError])
def test_a_cut_off_answer_is_refused(error_cls):
    with pytest.raises(error_cls, match="cut off"):
        raise_if_truncated(SimpleNamespace(stop_reason="max_tokens"), error_cls=error_cls, noun="extraction")


def test_a_finished_answer_passes():
    raise_if_truncated(SimpleNamespace(stop_reason="tool_use"), error_cls=ExtractionError, noun="extraction")
    raise_if_truncated(SimpleNamespace(), error_cls=ExtractionError, noun="extraction")  # fakes without the field


def test_classify_prompt_says_instrument_model_is_always_required():
    # Live runs (2026-10-28) on a FACSDiscover S8 form: about 3 answers in 8 left
    # `instrument_model` out, putting the model only in `detected_model`.
    assert "Always fill `instrument_model`" in classification._CLASSIFY_BODY


@pytest.mark.parametrize(
    "text",
    [
        pytest.param(build_classify_prompt([]), id="classify"),
        pytest.param(extraction._EXTRACT_PROMPT_HEADER, id="extract"),
        pytest.param(translation._PROMPT, id="translate"),
        pytest.param(_search_system_prompt([], [], []), id="search"),
    ],
)
def test_every_prompt_says_document_content_is_untrusted_and_its_instructions_are_ignored(text):
    # Prompt-injection guard (user decision D-3: all four prompts). The line must
    # name the content as untrusted data and say instructions printed in it are ignored.
    lowered = text.lower()
    assert "untrusted" in lowered
    assert "instructions" in lowered
    assert "ignore" in lowered
