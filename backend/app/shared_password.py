"""One shared password in front of the whole app (for a few testers).

Not accounts and not roles: anyone who knows the password gets in and can see and
change everything, and changing the password locks everyone out at once. It keeps
strangers off a public address; it does not say who did what. Real sign-in is a
separate, parked piece of work (docs: proposal-role-based-auth.md).

HTTP Basic, so the browser's own prompt does the work and every request, including
the PDF and file downloads, carries the credentials. Any user name is accepted;
only the password is checked, in constant time. `/health` stays open so the hosting
platform can probe it; it returns nothing but "ok". Wrong attempts are logged
(never the password) so a guessing run is visible. There is no lockout or rate
limit: the 12-character minimum in the settings is the protection against
guessing, which is why a short password is refused at startup.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import logging

from app.config import get_settings

logger = logging.getLogger("app.shared_password")

OPEN_PATHS = {"/health"}


def _password_from_header(value: str | None) -> str | None:
    if not value:
        return None
    scheme, _, token = value.partition(" ")
    if scheme.lower() != "basic":
        return None
    try:
        decoded = base64.b64decode(token.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError):
        return None
    _, _, password = decoded.partition(":")
    return password


class SharedPasswordMiddleware:
    """Pure ASGI middleware, so it adds nothing to streaming responses. Reads the
    password on each request, so it is a no-op when none is configured."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        expected = get_settings().shared_password
        if not expected or scope["path"] in OPEN_PATHS:
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        given = _password_from_header(headers.get("authorization"))
        if given is not None and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
            await self.app(scope, receive, send)
            return

        if given is not None:
            client = scope.get("client")
            logger.warning("Wrong shared password from %s for %s", client[0] if client else "unknown", scope["path"])
        body = b'{"detail":"A password is required."}'
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"www-authenticate", b'Basic realm="ServiceLedger", charset="UTF-8"'),
            ],
        })
        await send({"type": "http.response.body", "body": body})
