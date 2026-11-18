"""The prompts: shape of the answer asked for, no real customer details in the
examples, and a cut-off answer refused."""
from __future__ import annotations

import hashlib
import re
from types import SimpleNamespace

import pytest

from app.services import classification, extraction, translation
from app.services.classification_prompt import build_classify_prompt
from app.services.claude_client import raise_if_truncated
from app.services.errors import ClassificationError, ExtractionError
from app.services.report_query_model import _system_prompt as _search_system_prompt

# SHA-256 of each lower-cased real identifier or name that must never reach a prompt (the
# repository is public, so the values themselves are not kept here). The check hashes
# every letters-and-digits token of the prompt and looks it up.
REAL_DETAIL_HASHES = frozenset(
    (
        "04e9cf32e3a447f35bde0dd87369742da07b8c8781611c357de13f47e04c84a2",
        "0baa3af9450917f5c89bc4ba65e3cb4c6e3c2bba43d3ce0cc0cb857775122b4e",
        "0dd034af58e1c4a9c3e8af3e7de251be4b0fd7160cc068189d86d500a262b153",
        "2725d5ab224b9c1b655126c04773755c7c9e18a55dfebafc17d3ba12a655bc36",
        "40e44ffe97e741528f7720659277fadc44f5e54095ed969f94607a18754a0364",
        "456e3eacde6588de9a5a1e832f76f83048ae72c1a9a8c3b0504bd52d7a166705",
        "89af510b4a475f869f732e09aeff2c958fbe0f7efb1aa6aa0ec9c79b150fa437",
        "8fd4646c3a3dcca924206d2ed90ad118ce874fa586808a7e2f555fc0c152f55b",
        "91db30fa7ec6ddd041e2491f0a0781290268fd6439c8ff1d481169f8bd6748da",
        "a412fa752177f1bfa56e87fdf21be364f41d29bec0fb14052439e20bfecd9f44",
        "a8096181be46037420b313e20825991f5efa12209c1f29fd8040d557b39d71dd",
        "afdce2691622a1877b431c617dc27af9763b61cef6b36fa49c68d29b83ac53bb",
        "c10218366352e29aab7000ef7f801315d5e5906649d12dd158fdec155e15e021",
        "c45ec98f281dbd434db238bc729bc3af095083bdcf5f9da3784256ab612b1273",
        "c54b252a86f0a4aa058af068d1c57eedc1ca1ad0a0cb1993699aa3cee0c3e76f",
        "d356957a4fd501fd097654c713620e9288098cdb31ee71d34643c770d6074e6c",
        "e77dfb752b4d44ae8ff438f8cff37575315e6e26539c5ba29bf72c8ebe2d46bd",
        "fb9896ba0def8900c0c3f8b194c35ea6f40f7f00d448440f0cd811edf4871b73",
    )
)


def _real_details_in(text: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z0-9]+", text)
    return [t for t in tokens if hashlib.sha256(t.lower().encode()).hexdigest() in REAL_DETAIL_HASHES]


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
    assert _real_details_in(text) == []


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
