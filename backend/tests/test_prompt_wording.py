"""The prompts: shape of the answer asked for, no real customer details in the
examples, and a cut-off answer refused."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services import classification, extraction, translation
from app.services.claude_client import raise_if_truncated
from app.services.errors import ClassificationError, ExtractionError

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
