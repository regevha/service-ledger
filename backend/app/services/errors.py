"""Shared error types for the live-Claude services.

`classify()` and `extract()` (classification.py / extraction.py) each have a
live path that can fail in ways the stub path never could: the network call
itself can fail (timeout, connection drop, rate limit, a bad API key), or it
can succeed but come back in a shape the code doesn't expect (no tool_use
block, a required field missing or the wrong type — both observed in
practice during live validation, see extraction.py's _resolve_extraction_data
and the flat-schema comment on _build_extract_tool).

Both live paths catch those failures and re-raise as one of these two types,
with a message meant for a human reading a failed job's error_message, not a
stack trace. Callers (the routers) catch `LiveClaudeError` to record a
failed ExtractionJob instead of letting an unhandled exception 500 out with
no trace of what was attempted.
"""
from __future__ import annotations


class LiveClaudeError(RuntimeError):
    """Base class — catch this to handle either failure mode generically."""


class ClassificationError(LiveClaudeError):
    """Raised by classify()'s live path. See classification.py::_live_classify."""


class ExtractionError(LiveClaudeError):
    """Raised by extract()'s live path. See extraction.py::_live_extract."""
