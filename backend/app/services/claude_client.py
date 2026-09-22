"""Shared scaffolding for the two live-Claude services (classification.py,
extraction.py) — the cached Anthropic client, the deterministic stub-mode
hash helper, the "is this the spec's real sample document" marker list, and
the try/except/log/raise wrapper both live paths used to duplicate verbatim
around their `messages.create()` call and the tool_use-block extraction
that follows it.

`get_client()`/`stable_unit()` stay imported into each caller under their
own `_get_client`/`_stable_unit` names (`from app.services.claude_client
import get_client as _get_client`) rather than called directly from here, so
classification.py and extraction.py each keep an independently
monkeypatchable client getter — see tests/test_live_claude_parsing.py and
tests/test_live_claude_dispatch.py, which patch
`classification._get_client`/`extraction._get_client` separately per test.
For the same reason, `call_claude_tool` below takes an already-obtained
`client` rather than calling `get_client()` itself: the call site's own
`_get_client()` (the thing a test patches) has to be what actually runs.
"""
from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

import anthropic
from anthropic import Anthropic

from app.config import get_settings
from app.services.errors import LiveClaudeError

settings = get_settings()

# The real BD Care EU Work Order Service Report used throughout the spec
# (Case 03191457 / WO-04587090) — both classify() and extract() special-case
# any attachment whose file path matches one of these, in stub mode, so a
# demo run against that one real document reproduces its documented
# behavior exactly rather than a generic stub guess.
SAMPLE_MARKERS = ("wo-04587090", "sample", "work_order", "work-order")

_client: Anthropic | None = None


def get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(
            api_key=settings.anthropic_api_key,
            timeout=settings.anthropic_timeout_seconds,
            max_retries=settings.anthropic_max_retries,
        )
    return _client


def stable_unit(*parts: str) -> float:
    """A float in [0, 1), stable for the same inputs — stands in for "model
    confidence" (or a plausible stub value) without needing an actual model
    call."""
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def call_claude_tool(
    *,
    client: Anthropic,
    request_kwargs: dict[str, Any],
    error_cls: type[LiveClaudeError],
    logger: logging.Logger,
    attachment_path: str,
    verb: str,
    gerund: str,
    noun: str,
) -> Any:
    """Sends one forced tool-call request to Claude and returns the raw
    response. `client` is passed in (rather than fetched here) so
    classification.py's/extraction.py's own `_get_client()` stays the thing
    a test monkeypatches, exactly as before this was pulled out.

    Wraps the try/except/log/raise pattern both live paths used to write out
    by hand: an AuthenticationError/APIError is logged — the router/worker
    only ever store str(e) on the job row, so without this an auth failure
    was previously invisible anywhere a human would actually look while
    debugging live — and re-raised as `error_cls`; a successful call logs
    its elapsed time and token usage either way. `verb` ("classify"/
    "extract"), `gerund` ("classifying"/"extracting") and `noun`
    ("classification"/"extraction") are the English forms the log/error
    messages need — see classification.py/extraction.py for exactly which
    wording each call site uses.
    """
    call_started = time.perf_counter()
    try:
        response = client.messages.create(**request_kwargs)
    except anthropic.AuthenticationError as e:
        logger.exception(
            "Claude API authentication failed %s attachment %s after %.2fs",
            gerund,
            attachment_path,
            time.perf_counter() - call_started,
        )
        raise error_cls(f"Claude API authentication failed — check ANTHROPIC_API_KEY: {e}") from e
    except anthropic.APIError as e:
        logger.exception(
            "Claude API request failed %s attachment %s after %.2fs",
            gerund,
            attachment_path,
            time.perf_counter() - call_started,
        )
        raise error_cls(f"Claude API request failed during {noun}: {e}") from e

    usage = getattr(response, "usage", None)
    logger.info(
        "Claude %s API call for attachment %s completed in %.2fs (input_tokens=%s, output_tokens=%s)",
        verb,
        attachment_path,
        time.perf_counter() - call_started,
        getattr(usage, "input_tokens", "?"),
        getattr(usage, "output_tokens", "?"),
    )
    return response


def extract_tool_use(
    response: Any,
    *,
    error_cls: type[LiveClaudeError],
    logger: logging.Logger,
    attachment_path: str,
    gerund: str,
    noun: str,
) -> Any:
    """Pulls the forced tool_use block out of a call_claude_tool response,
    raising `error_cls` (logged first, same reasoning as call_claude_tool)
    if Claude answered without one — tool-use input isn't strictly validated
    against the schema (see extraction.py's flat-schema comment for a case
    where that showed up in practice), so an empty/text-only response is a
    real failure mode worth naming clearly, not a `next()` StopIteration to
    crash on."""
    try:
        return next(block for block in response.content if block.type == "tool_use")
    except StopIteration as e:
        logger.error(
            "Claude returned no tool_use block %s attachment %s (got block types: %s)",
            gerund,
            attachment_path,
            [getattr(block, "type", "?") for block in response.content],
        )
        raise error_cls(
            f"Claude did not return the expected tool call for {noun} (no tool_use block in the response)"
        ) from e
