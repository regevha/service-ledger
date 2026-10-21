"""Gives every request an id and logs one line when it finishes.

The id is taken from an incoming X-Request-ID header when it is short and made of
safe characters (so a caller can supply its own), otherwise generated. It is sent
back in the X-Request-ID response header. The line says method, path, status and
time. The query string is never logged (a search box value is document text).
/health is logged at DEBUG only, so the hosting platform's probes do not drown
the log.

Pure ASGI, and the outermost layer, so a refused password (401) is logged too.
An exception no route handled passes through here on its way to the 500 handler
in main.py; the handler adds the same id to its answer from scope["request_id"].
"""
from __future__ import annotations

import logging
import re
import time

from app.trace import new_request_id, request_id_var

logger = logging.getLogger("app.request")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestTraceMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = next((v.decode("latin-1") for k, v in scope["headers"] if k == b"x-request-id"), "")
        rid = incoming if _SAFE_ID.match(incoming) else new_request_id()
        scope["request_id"] = rid
        token = request_id_var.set(rid)
        started = time.perf_counter()
        status = {"code": 0}

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                message = {**message, "headers": [*message.get("headers", []), (b"x-request-id", rid.encode())]}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            self._log(scope, 500, started, unhandled=True)
            raise
        else:
            self._log(scope, status["code"], started)
        finally:
            request_id_var.reset(token)

    @staticmethod
    def _log(scope, code: int, started: float, unhandled: bool = False) -> None:
        elapsed_ms = (time.perf_counter() - started) * 1000
        path = scope["path"]
        routine = path == "/health" or (scope["method"] == "GET" and path.startswith("/extraction-jobs/") and code < 400)
        level = logging.ERROR if unhandled or code >= 500 else (logging.DEBUG if routine else logging.INFO)
        logger.log(level, "%s %s -> %s in %.0f ms%s", scope["method"], path, code, elapsed_ms, " (unhandled error)" if unhandled else "")
