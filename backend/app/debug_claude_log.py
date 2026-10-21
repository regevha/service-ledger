"""Debug log of every Claude API call (docs: claude/proposal-debug-log.md, phase 1).

Off unless DEBUG_CLAUDE_LOG is set, and then only by whoever runs the deployment:
there is no switch in the app and no endpoint. When off, `record_call` returns at
its first line and nothing is built, hashed or written.

  light  one JSON line per call: time, kind, model, job / report / attachment ids,
         a description of each document (type, size, SHA-256, never the bytes), the
         length of each text block, the tool name, the raw response (the tool input,
         stop reason, token usage, Anthropic request id) or the error, and timing.
  deep   light plus the system prompt, the prompt text and the tool schema.

The log holds the same service-report data the database does (customer names,
serials, technician names) in a second place without the app's access rules, so
treat the folder like the database: the folder is created 0700 and files 0600.
No masking of free text is done. The API key is removed from anything written
(the exact key and anything shaped like one). A failure to log is swallowed and
noted in the normal log; it never fails a Claude call.

Files are one per UTC day, `claude-calls-YYYY-MM-DD.jsonl`, and files older than
DEBUG_CLAUDE_LOG_DAYS (default 7) are deleted. Each record is one write in append
mode, which is safe for the API and the worker writing the same file on a local
disk or a mounted share. In stub mode no Claude call happens, so nothing is
recorded; the startup warning says so.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from app.config import get_settings
from app.trace import attachment_id_var, job_id_var, report_id_var

logger = logging.getLogger("app.debug_claude_log")

_FILE_RE = re.compile(r"^claude-calls-(\d{4}-\d{2}-\d{2})\.jsonl$")
_KEY_SHAPE = re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}")
_ON = {"light": "light", "deep": "deep", "true": "light", "1": "light", "on": "light", "yes": "light"}
_last_purge: date | None = None


def level() -> str:
    """"light", "deep" or "" (off). An unrecognised value counts as off."""
    return _ON.get(get_settings().debug_claude_log.strip().lower(), "")


def log_dir() -> Path:
    settings = get_settings()
    if settings.debug_claude_log_dir:
        return Path(settings.debug_claude_log_dir)
    return Path(settings.attachment_storage_dir).resolve().parent / "debug-claude"


def announce_debug_log() -> None:
    """At startup of the API and the worker: say loudly that the log is on, or that a
    value was not understood."""
    settings = get_settings()
    raw = settings.debug_claude_log.strip()
    if not raw:
        return
    if not level():
        logger.warning("DEBUG_CLAUDE_LOG=%r is not understood (use light or deep); the debug log is OFF.", raw)
        return
    logger.warning(
        "Claude debug log is ON (level=%s), writing to %s; files older than %d days are deleted. "
        "It holds service-report data: switch it off when the investigation is done.",
        level(),
        log_dir(),
        settings.debug_claude_log_days,
    )
    if not settings.use_live_claude:
        logger.warning("USE_LIVE_CLAUDE is false (stub mode): no Claude calls happen, so nothing will be recorded.")


def _scrub(text: str) -> str:
    key = get_settings().anthropic_api_key
    if key:
        text = text.replace(key, "[redacted]")
    return _KEY_SHAPE.sub("[redacted]", text)


def _describe_request(request_kwargs: dict[str, Any], deep: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "model": request_kwargs.get("model"),
        "max_tokens": request_kwargs.get("max_tokens"),
        "tool_choice": request_kwargs.get("tool_choice"),
        "tools": [t.get("name") for t in request_kwargs.get("tools") or []],
        "documents": [],
        "text_chars": [],
    }
    texts: list[str] = []
    for message in request_kwargs.get("messages") or []:
        content = message.get("content")
        blocks = content if isinstance(content, list) else [{"type": "text", "text": content}]
        for block in blocks:
            kind = block.get("type")
            if kind in ("document", "image"):
                source = block.get("source") or {}
                size, digest = None, None
                data = source.get("data")
                if isinstance(data, str):
                    try:
                        raw = base64.b64decode(data)
                        size, digest = len(raw), hashlib.sha256(raw).hexdigest()
                    except Exception:  # noqa: BLE001 - a description must not fail the call
                        pass
                out["documents"].append({"type": kind, "media_type": source.get("media_type"), "bytes": size, "sha256": digest})
            elif kind == "text":
                text = block.get("text") or ""
                out["text_chars"].append(len(text))
                texts.append(text)
    if deep:
        out["system"] = request_kwargs.get("system")
        out["prompt_text"] = texts
        out["tool_schemas"] = request_kwargs.get("tools")
    return out


def _describe_response(response: Any) -> dict[str, Any]:
    usage = getattr(response, "usage", None)
    blocks = []
    for block in getattr(response, "content", None) or []:
        kind = getattr(block, "type", "?")
        if kind == "tool_use":
            blocks.append({"type": kind, "name": getattr(block, "name", None), "input": getattr(block, "input", None)})
        elif kind == "text":
            blocks.append({"type": kind, "text": getattr(block, "text", "")})
        else:
            blocks.append({"type": kind})
    return {
        "stop_reason": getattr(response, "stop_reason", None),
        "anthropic_request_id": getattr(response, "_request_id", None),
        "usage": {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
            "cache_creation_input_tokens": getattr(usage, "cache_creation_input_tokens", None),
        },
        "content": blocks,
    }


def _purge_old(directory: Path, keep_days: int) -> None:
    global _last_purge
    today = datetime.now(timezone.utc).date()
    if _last_purge == today:
        return
    _last_purge = today
    cutoff = today - timedelta(days=keep_days)
    for path in directory.iterdir():
        match = _FILE_RE.match(path.name)
        if match and date.fromisoformat(match.group(1)) < cutoff:
            path.unlink(missing_ok=True)


def record_call(
    *,
    verb: str,
    request_kwargs: dict[str, Any],
    response: Any = None,
    error: BaseException | None = None,
    elapsed_seconds: float,
    attachment_path: str,
) -> None:
    """Write one record for one Claude call. Never raises."""
    chosen = level()
    if not chosen:
        return
    try:
        settings = get_settings()
        record = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": chosen,
            "kind": verb,
            "job_id": job_id_var.get(),
            "report_id": report_id_var.get(),
            "attachment_id": attachment_id_var.get(),
            "file": os.path.basename(attachment_path.replace("\\", "/")),
            "request": _describe_request(request_kwargs, deep=chosen == "deep"),
            "elapsed_seconds": round(elapsed_seconds, 3),
            "max_retries_configured": settings.anthropic_max_retries,
        }
        if error is not None:
            record["error"] = {"type": type(error).__name__, "message": str(error)}
        else:
            record["response"] = _describe_response(response)
        line = _scrub(json.dumps(record, ensure_ascii=False, default=str)) + "\n"

        directory = log_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        _purge_old(directory, settings.debug_claude_log_days)
        path = directory / f"claude-calls-{datetime.now(timezone.utc).date().isoformat()}.jsonl"
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
    except Exception as exc:  # noqa: BLE001 - a broken debug log must never fail an extraction
        logger.warning("Could not write the Claude debug log record: %s: %s", type(exc).__name__, exc)
