"""What kinds of scanned original the app accepts, and how one is handed to
Claude.

Claude's API takes a PDF as a `document` content block and a picture as an
`image` block; the media type must match the bytes. Both live calls
(classification.py, extraction.py) used to build a `document` block with a
hard-coded "application/pdf" for every attachment, so a JPEG or PNG scan —
which the upload box has always accepted — went out labelled as a PDF and
could not be read. The type is now decided here, once, from the file's own
leading bytes rather than from the browser-supplied content type (which is
whatever the client says it is), and both the upload endpoint and the live
calls use it.
"""
from __future__ import annotations

import base64
from pathlib import Path

PDF = "application/pdf"
IMAGE_TYPES = ("image/png", "image/jpeg", "image/gif", "image/webp")
ACCEPTED_TYPES = (PDF, *IMAGE_TYPES)

# Shown to the user when an upload is refused for its type.
ACCEPTED_DESCRIPTION = "a PDF or a PNG, JPEG, GIF or WebP image"


def detect_media_type(data: bytes) -> str | None:
    """The media type of `data` from its magic bytes, or None when it is not
    one of ACCEPTED_TYPES. PDF readers accept the "%PDF-" header anywhere in
    the first 1024 bytes, so this does too."""
    if b"%PDF-" in data[:1024]:
        return PDF
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


class UnsupportedDocumentError(ValueError):
    """The stored file is not a PDF or a supported image."""


def claude_content_block(path: str | Path) -> dict:
    """The content block that sends the file at `path` to Claude: a `document`
    block for a PDF, an `image` block for a picture. Raises
    UnsupportedDocumentError when the bytes are neither (callers turn that
    into their own ClassificationError / ExtractionError)."""
    data = Path(path).read_bytes()
    media_type = detect_media_type(data)
    if media_type is None:
        raise UnsupportedDocumentError(
            f"The stored file is not {ACCEPTED_DESCRIPTION}, so Claude cannot read it."
        )
    source = {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(data).decode("ascii")}
    return {"type": "document" if media_type == PDF else "image", "source": source}
