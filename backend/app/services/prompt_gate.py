"""Debug aid: stop before a Claude call so a person can read the prompt first.

With VIEW_PROMPTS=true, `call_claude_tool` raises `PromptApprovalNeeded` instead
of sending the request. The worker stores the preview on the job and parks it as
`awaiting_approval`; the person presses Send (the job is queued again with
`params["prompt_approved"]`, and this time the call goes out) or Cancel (the job
fails). Nothing is sent to Anthropic until Send. Documents are described (type,
size, SHA-256), never included as bytes.
"""
from __future__ import annotations

import base64
import contextvars
import hashlib
from typing import Any

# Set by the worker for the job being run; true once the person pressed Send.
approved_var: contextvars.ContextVar[bool] = contextvars.ContextVar("prompt_approved", default=False)


class PromptApprovalNeeded(Exception):
    """Raised in place of a Claude call; carries the preview to show."""

    def __init__(self, preview: dict[str, Any]) -> None:
        super().__init__("Waiting for approval to send the prompt to Claude.")
        self.preview = preview


def build_preview(request_kwargs: dict[str, Any], verb: str) -> dict[str, Any]:
    """The exact request, as plain JSON for the screen: every text block in full,
    the tool schema, and a description of each attached document."""
    blocks: list[dict[str, Any]] = []
    for message in request_kwargs.get("messages") or []:
        content = message.get("content")
        parts = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for part in parts:
            kind = part.get("type")
            if kind in ("document", "image"):
                source = part.get("source") or {}
                size = digest = None
                data = source.get("data")
                if isinstance(data, str):
                    try:
                        raw = base64.b64decode(data)
                        size, digest = len(raw), hashlib.sha256(raw).hexdigest()
                    except Exception:  # noqa: BLE001 - a preview must not fail
                        pass
                blocks.append(
                    {"type": kind, "role": message.get("role"), "media_type": source.get("media_type"),
                     "bytes": size, "sha256": digest}
                )
            else:
                blocks.append({"type": "text", "role": message.get("role"), "text": part.get("text") or ""})
    return {
        "verb": verb,
        "model": request_kwargs.get("model"),
        "max_tokens": request_kwargs.get("max_tokens"),
        "system": request_kwargs.get("system"),
        "tool_choice": request_kwargs.get("tool_choice"),
        "tools": request_kwargs.get("tools"),
        "blocks": blocks,
    }
