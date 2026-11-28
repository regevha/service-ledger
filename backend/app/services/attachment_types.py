"""Which email attachments email intake may even look at.

An attachment is hostile data. Its file name and the content type its sender
declares are claims, not facts, so neither decides anything here. The decision
comes from the first bytes of the file, and only types the reading step can
actually read are allowed (today: PDF). Everything else is refused up front,
before it is hashed, parsed, stored or counted as a report candidate.

`classify_attachment` never raises and never returns text taken from the file:
`detected` is a fixed label from this module, for tests and DEBUG logs only.
The sender is told a fixed sentence (see `_REPLY_REASONS` in
`services/email_intake.py`), never the label.

To accept another type later, add it to `SUPPORTED_TYPES` together with its own
safety check and relevance path; do not widen the PDF rules.
"""
from __future__ import annotations

from dataclasses import dataclass

# Types the reading step can read. Keep this in step with what intake can
# actually check and read; a new type needs its own check (see pdf_safety).
SUPPORTED_TYPES = frozenset({"pdf"})

REASON_UNSUPPORTED = "unsupported_type"
REASON_MISMATCH = "type_mismatch"

# Content types a mail client may put on a real PDF. Anything else declared on a
# file whose bytes are a PDF is a mismatch (a disguise, or a polyglot file).
_PDF_DECLARED = frozenset(
    {
        "",
        "application/pdf",
        "application/x-pdf",
        "application/acrobat",
        "application/vnd.pdf",
        "application/octet-stream",
        "binary/octet-stream",
        "application/force-download",
        "application/download",
        "application/x-download",
    }
)

# (leading bytes, label). Only to name what a refused file looked like.
_SIGNATURES: tuple[tuple[bytes, str], ...] = (
    (b"%PDF-", "pdf"),
    (b"PK\x03\x04", "zip"),
    (b"PK\x05\x06", "zip"),
    (b"PK\x07\x08", "zip"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "ole"),
    (b"MZ", "executable"),
    (b"\x7fELF", "executable"),
    (b"\xca\xfe\xba\xbe", "executable"),
    (b"\xcf\xfa\xed\xfe", "executable"),
    (b"#!", "script"),
    (b"\x89PNG\r\n\x1a\n", "image"),
    (b"\xff\xd8\xff", "image"),
    (b"GIF87a", "image"),
    (b"GIF89a", "image"),
    (b"RIFF", "riff"),
    (b"{\\rtf", "rtf"),
    (b"Rar!\x1a\x07", "archive"),
    (b"7z\xbc\xaf\x27\x1c", "archive"),
    (b"\x1f\x8b", "archive"),
    (b"BZh", "archive"),
)
_HTML_MARKERS = (b"<html", b"<!doctype", b"<script", b"<body", b"<?xml", b"<svg")
_SNIFF_BYTES = 512


@dataclass(frozen=True)
class TypeVerdict:
    supported: bool
    # None when supported; otherwise REASON_UNSUPPORTED or REASON_MISMATCH.
    reason_code: str | None
    # Fixed label for tests and DEBUG logs. Never shown to the sender.
    detected: str


def detect_type(data: bytes) -> str:
    """Name the kind of file from its leading bytes. Never raises."""
    if not isinstance(data, (bytes, bytearray)) or not data:
        return "empty"
    head = bytes(data[:_SNIFF_BYTES])
    for prefix, label in _SIGNATURES:
        if head.startswith(prefix):
            return label
    lowered = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if lowered.startswith(_HTML_MARKERS):
        return "html"
    if b"\x00" in head:
        return "binary"
    return "text"


def classify_attachment(data: bytes, declared_type: str = "") -> TypeVerdict:
    """Decide from the bytes (not the name or the declared type) whether intake
    may process this attachment. A PDF whose declared type points at something
    else is refused as a mismatch."""
    try:
        detected = detect_type(data)
        if detected not in SUPPORTED_TYPES:
            return TypeVerdict(False, REASON_UNSUPPORTED, detected)
        declared = (declared_type or "").strip().lower()
        if declared not in _PDF_DECLARED:
            return TypeVerdict(False, REASON_MISMATCH, detected)
        return TypeVerdict(True, None, detected)
    except Exception:  # noqa: BLE001 - hostile input must not escape
        return TypeVerdict(False, REASON_UNSUPPORTED, "unknown")
