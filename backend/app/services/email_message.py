"""Reading one raw email for intake. The message is hostile data.

`parse_message(raw)` returns only what intake needs (AC-24, PLAN.md "Privacy and
security"):

* the From address, when there is exactly one (never Reply-To, Sender, Cc);
* a message key for dedupe (AC-18);
* whether the mail is an auto-reply or bulk mail;
* whether a trusted `Authentication-Results` header vouches for the sender;
* the attachments: bytes, 1-based position and declared content type.

It never returns, stores or logs the subject, the body, an attachment name or
any other header. Nothing in the message is ever executed or followed. It never
raises: a message it cannot read comes back with `unreadable=True`.

Bounds: a message over `max_message_bytes` is not parsed (`too_large`); at most
`MAX_PARTS` MIME parts are visited (`parts_limit_reached`); parts nested
inside an attached message (`message/*`) are not opened.
"""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass, field
from email import policy
from email.message import Message
from email.parser import BytesParser
from email.utils import getaddresses

logger = logging.getLogger("app.services.email_message")

MAX_PARTS = 50
MAX_ADDRESS_LENGTH = 254

_ADDRESS_OK = re.compile(r"^[^@\s<>(),;:\\\"\[\]\x00-\x1f\x7f]+@[^@\s<>(),;:\\\"\[\]\x00-\x1f\x7f]+$")
_BULK_PRECEDENCE = frozenset({"bulk", "list", "junk"})
_COMMENT = re.compile(r"\([^()]*\)")


@dataclass(frozen=True)
class Attachment:
    """One attachment. `declared_type` is what the sender claims; trust only
    the bytes (see `pdf_safety.check_pdf`). The file name is not kept."""

    position: int  # 1-based, in the order found in the message
    data: bytes
    declared_type: str  # lower-case "maintype/subtype", or "" when missing

    @property
    def size_bytes(self) -> int:
        return len(self.data)

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.data).hexdigest()


@dataclass(frozen=True)
class ParsedMessage:
    # Lower-case address, or None when the From header is missing, malformed or
    # holds more than one address (the sender is then unknown).
    from_address: str | None = None
    # 64 hex chars (SHA-256). Empty when the message was not parsed.
    message_key: str = ""
    # Auto-Submitted other than "no", Precedence bulk/list/junk, or an empty
    # Return-Path (a bounce). Such mail is ignored and never answered.
    is_auto_reply: bool = False
    # True/False when a trusted authserv-id was given; None when it was not
    # (folder mailbox: no check is possible).
    sender_verified: bool | None = None
    attachments: tuple[Attachment, ...] = field(default_factory=tuple)
    parts_limit_reached: bool = False
    too_large: bool = False  # not parsed: over the size limit
    unreadable: bool = False  # the parser failed


def parse_message(
    raw: bytes,
    trusted_authserv_id: str | None = None,
    max_message_bytes: int | None = None,
) -> ParsedMessage:
    """Parse `raw`. Never raises."""
    try:
        if not isinstance(raw, (bytes, bytearray)):
            return ParsedMessage(unreadable=True)
        if max_message_bytes is not None and len(raw) > max_message_bytes:
            return ParsedMessage(too_large=True)
        return _parse(bytes(raw), trusted_authserv_id)
    except Exception as exc:  # noqa: BLE001 - hostile input must not escape
        logger.debug("message unreadable: %s", type(exc).__name__)
        return ParsedMessage(unreadable=True)


def _parse(raw: bytes, trusted_authserv_id: str | None) -> ParsedMessage:
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    attachments, limit_reached = _collect_attachments(msg)
    from_address = _single_from(msg)
    verified: bool | None = None
    if trusted_authserv_id:
        verified = from_address is not None and authentication_verdict(
            _headers(msg, "Authentication-Results"), trusted_authserv_id, from_address
        )
    return ParsedMessage(
        from_address=from_address,
        message_key=_message_key(msg, attachments),
        is_auto_reply=_is_auto_reply(msg),
        sender_verified=verified,
        attachments=tuple(attachments),
        parts_limit_reached=limit_reached,
    )


def _headers(msg: Message, name: str) -> list[str]:
    values: list[str] = []
    for value in msg.get_all(name, []) or []:
        try:
            values.append(str(value))
        except Exception:  # noqa: BLE001 - a header the parser cannot render
            continue
    return values


def _first_header(msg: Message, name: str) -> str | None:
    values = _headers(msg, name)
    return values[0] if values else None


def _single_from(msg: Message) -> str | None:
    """Exactly one valid address across all From headers, else None."""
    headers = _headers(msg, "From")
    if not headers:
        return None
    found = {addr.strip().lower() for _, addr in getaddresses(headers) if addr.strip()}
    if len(found) != 1:
        return None
    address = found.pop()
    if len(address) > MAX_ADDRESS_LENGTH or not _ADDRESS_OK.match(address):
        return None
    if "." not in address.rsplit("@", 1)[1]:
        return None
    return address


def _message_key(msg: Message, attachments: list[Attachment]) -> str:
    """SHA-256 of the normalized Message-ID; without one, of the Date header
    and the SHA-256 of every attachment. The raw Message-ID is not kept."""
    message_id = (_first_header(msg, "Message-ID") or "").strip().strip("<>").strip().lower()
    if message_id:
        material = "mid:" + message_id
    else:
        parts = [(_first_header(msg, "Date") or "").strip()]
        parts.extend(a.sha256 for a in attachments)
        material = "nomid:" + "|".join(parts)
    return hashlib.sha256(material.encode("utf-8", "replace")).hexdigest()


def _is_auto_reply(msg: Message) -> bool:
    auto = (_first_header(msg, "Auto-Submitted") or "").strip().lower()
    if auto and not auto.startswith("no"):
        return True
    precedence = (_first_header(msg, "Precedence") or "").strip().lower()
    if precedence in _BULK_PRECEDENCE:
        return True
    return_path = _first_header(msg, "Return-Path")
    return return_path is not None and return_path.strip().replace(" ", "") == "<>"


def _collect_attachments(msg: Message) -> tuple[list[Attachment], bool]:
    """Walk at most MAX_PARTS parts, depth first in message order."""
    attachments: list[Attachment] = []
    stack: list[Message] = [msg]
    visited = 0
    while stack:
        part = stack.pop()
        visited += 1
        if visited > MAX_PARTS:
            return attachments, True
        maintype = part.get_content_maintype()
        if maintype == "message":
            # An attached message is one non-PDF attachment; it is not opened.
            attachments.append(Attachment(len(attachments) + 1, b"", part.get_content_type()))
            continue
        if part.is_multipart():
            children = list(part.iter_parts())  # type: ignore[attr-defined]
            stack.extend(reversed(children))
            continue
        if _is_body(part):
            continue
        payload = part.get_payload(decode=True)
        data = payload if isinstance(payload, bytes) else b""
        declared = part.get_content_type() if part.get("Content-Type") else ""
        attachments.append(Attachment(len(attachments) + 1, data, declared))
    return attachments, False


def _is_body(part: Message) -> bool:
    """A text/plain or text/html part that is not an attachment is the body."""
    if part.get_content_maintype() != "text" or part.get_content_subtype() not in {"plain", "html"}:
        return False
    disposition = (part.get_content_disposition() or "").lower()
    return disposition != "attachment" and part.get_filename() is None


_RESULT = re.compile(r"^\s*([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)", re.IGNORECASE)
_PROP = re.compile(r"([a-z0-9_-]+\.[a-z0-9_-]+)\s*=\s*([^\s;]+)", re.IGNORECASE)


def authentication_verdict(
    results_headers: list[str], trusted_authserv_id: str, from_address: str
) -> bool:
    """True when the topmost Authentication-Results header written by
    `trusted_authserv_id` shows DMARC pass, or DKIM or SPF pass aligned with
    the From domain. Headers from any other authserv-id are ignored (a sender
    can add its own). Alignment is relaxed: the authenticated domain equals the
    From domain or is a parent of it."""
    trusted = trusted_authserv_id.strip().lower()
    from_domain = from_address.rsplit("@", 1)[-1].lower()
    for header in results_headers:  # topmost first
        clauses = _COMMENT.sub("", header).split(";")
        authserv = clauses[0].strip().split()[0].lower() if clauses[0].strip() else ""
        if authserv != trusted:
            continue
        return any(_clause_passes(clause, from_domain) for clause in clauses[1:])
    return False


def _clause_passes(clause: str, from_domain: str) -> bool:
    head = _RESULT.match(clause)
    if head is None or head.group(2).lower() != "pass":
        return False
    method = head.group(1).lower()
    if method == "dmarc":
        return True
    props = {k.lower(): v.strip("\"'").lower() for k, v in _PROP.findall(clause)}
    if method == "dkim":
        return _aligned(props.get("header.d", ""), from_domain)
    if method == "spf":
        mailfrom = props.get("smtp.mailfrom", "")
        return _aligned(mailfrom.rsplit("@", 1)[-1], from_domain)
    return False


def _aligned(authenticated: str, from_domain: str) -> bool:
    authenticated = authenticated.strip(".")
    return "." in authenticated and (
        from_domain == authenticated or from_domain.endswith("." + authenticated)
    )
