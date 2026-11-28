"""Structural check of a PDF that arrived from outside (email intake).

A PDF from an email is hostile until proven otherwise. `check_pdf` decides, from
the bytes alone, whether the file may be kept and later opened by the reading
step. It never raises, whatever the input, and it never logs or returns text
taken from the file.

It refuses (AC-06, AC-07, AC-08):

* a file that does not start with the PDF magic bytes (`not_pdf`);
* a file over the shared PDF size limit (`too_large`);
* an encrypted, damaged or unreadable file, or one with no pages, or with more
  objects or pages than a service report ever has (`unsafe_pdf`);
* a file that carries JavaScript, a launch action, an embedded file, rich
  media or an XFA form (`unsafe_pdf`), or an /OpenAction that is not a plain
  jump to a page.

The check is a belt and braces pair. The object walk resolves every object
the file declares, including those packed in compressed object streams, and
looks at dictionary keys and name values. The raw scan reads the bytes outside
streams, with `#xx` name escapes decoded, and catches what the walk cannot
see. Neither runs the file's content, and `pypdfium2` (native code) is not
used here.

`PdfVerdict.detail` is a fixed internal code for tests and DEBUG logs. It is
not for the sender: the reply only says "could not be accepted" (AC-08).
"""
from __future__ import annotations

import io
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

from pypdf import PdfReader
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    IndirectObject,
    NameObject,
    StreamObject,
)

from app.config import get_settings

logger = logging.getLogger("app.services.pdf_safety")

PdfStatus = Literal["ok", "not_pdf", "too_large", "unsafe_pdf"]

# The file must start with these bytes. A header after leading junk is a
# common way to hide a polyglot file, so it is refused.
PDF_MAGIC = b"%PDF-"

# A service report has a handful of pages and a few hundred objects. Anything
# far beyond that is refused rather than parsed (a time and memory bound).
MAX_PAGES = 200
MAX_OBJECTS = 50_000
MAX_WALK_DEPTH = 40
# Wall-clock budget for the whole structural check, in seconds.
TIME_BUDGET_SECONDS = 10.0
# A complete file ends with %%EOF. Some writers add a little trailing data.
EOF_WINDOW = 2048

# Names that make a PDF unsafe wherever they appear as a key or a name value.
FORBIDDEN_NAMES = frozenset(
    {
        "/JavaScript",
        "/JS",
        "/Launch",
        "/EmbeddedFile",
        "/EmbeddedFiles",
        "/EF",
        "/FileAttachment",
        "/RichMedia",
        "/XFA",
        "/GoToE",
    }
)
# Actions that may be an /OpenAction. Everything else (URI, SubmitForm,
# Named, ImportData, ...) is refused. A bare destination array is fine.
SAFE_OPEN_ACTIONS = frozenset({"/GoTo"})

_NAME_END = rb"(?=[\s()<>\[\]{}/%]|$)"
_RAW_FORBIDDEN = re.compile(
    rb"/(?:JavaScript|JS|Launch|EmbeddedFiles?|EF|FileAttachment|RichMedia|XFA|GoToE)"
    + _NAME_END
)
_STREAM_BODY = re.compile(rb"stream\r?\n.*?endstream", re.DOTALL)
_HEX_ESCAPE = re.compile(rb"#([0-9A-Fa-f]{2})")


@dataclass(frozen=True)
class PdfVerdict:
    """Result of `check_pdf`. `page_count` is set only when `status == "ok"`."""

    status: PdfStatus
    page_count: int | None = None
    detail: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


class _Unsafe(Exception):
    """Internal: carries a fixed detail code."""


def check_pdf(data: bytes, max_bytes: int | None = None) -> PdfVerdict:
    """Decide whether `data` is a safe, readable PDF. Never raises."""
    try:
        return _check(data, max_bytes)
    except _Unsafe as exc:
        logger.debug("pdf refused: %s", exc)
        return PdfVerdict("unsafe_pdf", None, str(exc))
    except Exception as exc:  # noqa: BLE001 - hostile input must not escape
        logger.debug("pdf unreadable: %s", type(exc).__name__)
        return PdfVerdict("unsafe_pdf", None, "unreadable")


def _check(data: bytes, max_bytes: int | None) -> PdfVerdict:
    if not isinstance(data, (bytes, bytearray)) or bytes(data[:5]) != PDF_MAGIC:
        return PdfVerdict("not_pdf", None, "bad_magic")
    limit = max_bytes if max_bytes is not None else get_settings().max_pdf_upload_bytes
    if len(data) > limit:
        return PdfVerdict("too_large", None, "over_limit")
    data = bytes(data)
    deadline = time.monotonic() + TIME_BUDGET_SECONDS

    if b"%%EOF" not in data[-EOF_WINDOW:]:
        raise _Unsafe("truncated")
    _raw_scan(data)

    reader = PdfReader(io.BytesIO(data), strict=False)
    if reader.is_encrypted or "/Encrypt" in reader.trailer:
        raise _Unsafe("encrypted")

    _walk_all_objects(reader, deadline)

    pages = len(reader.pages)
    if pages < 1:
        raise _Unsafe("no_pages")
    if pages > MAX_PAGES:
        raise _Unsafe("too_many_pages")
    first = reader.pages[0]
    if not isinstance(first, DictionaryObject):
        raise _Unsafe("unreadable_page")
    return PdfVerdict("ok", pages, None)


def _raw_scan(data: bytes) -> None:
    """Look for forbidden names in the bytes outside streams (escapes decoded)."""
    outside = _STREAM_BODY.sub(b"", data)
    decoded = _HEX_ESCAPE.sub(lambda m: bytes([int(m.group(1), 16)]), outside)
    if _RAW_FORBIDDEN.search(decoded):
        raise _Unsafe("forbidden_name")


def _object_numbers(reader: PdfReader) -> list[int]:
    numbers: set[int] = set()
    for table in reader.xref.values():
        numbers.update(int(n) for n in table)
    numbers.update(int(n) for n in reader.xref_objStm)
    if len(numbers) > MAX_OBJECTS:
        raise _Unsafe("too_many_objects")
    return sorted(numbers)


def _walk_all_objects(reader: PdfReader, deadline: float) -> None:
    seen: set[int] = set()
    roots: list[Any] = [reader.trailer]
    for number in _object_numbers(reader):
        if time.monotonic() > deadline:
            raise _Unsafe("too_slow")
        try:
            roots.append(IndirectObject(number, 0, reader).get_object())
        except Exception:  # noqa: BLE001 - one bad object: the file is damaged
            raise _Unsafe("damaged_object") from None
    for root in roots:
        _walk(root, 0, seen, deadline)


def _walk(node: Any, depth: int, seen: set[int], deadline: float) -> None:
    if depth > MAX_WALK_DEPTH:
        raise _Unsafe("too_deep")
    if time.monotonic() > deadline:
        raise _Unsafe("too_slow")
    if isinstance(node, IndirectObject):
        # Targets are visited as roots of their own; do not chase (loops).
        if node.idnum in seen:
            return
        seen.add(node.idnum)
        try:
            node = node.get_object()
        except Exception:  # noqa: BLE001
            raise _Unsafe("damaged_object") from None
    if isinstance(node, NameObject):
        if str(node) in FORBIDDEN_NAMES:
            raise _Unsafe("forbidden_name")
        return
    if isinstance(node, ArrayObject):
        for item in node:
            _walk(item, depth + 1, seen, deadline)
        return
    if isinstance(node, DictionaryObject):  # includes StreamObject
        if isinstance(node, StreamObject) and node.get("/Type") == "/EmbeddedFile":
            raise _Unsafe("forbidden_name")
        for key, value in node.items():
            if str(key) in FORBIDDEN_NAMES:
                raise _Unsafe("forbidden_name")
            if str(key) == "/OpenAction":
                _check_open_action(value)
            _walk(value, depth + 1, seen, deadline)


def _check_open_action(value: Any) -> None:
    resolved = value.get_object() if isinstance(value, IndirectObject) else value
    if isinstance(resolved, ArrayObject):
        return  # a plain destination: "open at this page"
    if isinstance(resolved, DictionaryObject):
        if str(resolved.get("/S", "")) in SAFE_OPEN_ACTIONS:
            return
    raise _Unsafe("open_action")
