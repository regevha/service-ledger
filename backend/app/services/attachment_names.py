"""The two names an uploaded scan has, kept apart on purpose.

* The **stored name** is what the file is called on disk: a fresh UUID plus an
  extension taken from the detected media type. It never contains anything the
  uploader typed, so it cannot collide, escape the report folder, run into the
  filename limits of the storage (Azure Files is an SMB share, and a Hebrew name
  takes two bytes a letter against a 255 byte limit) or differ by Unicode
  normalisation form between the machine that made it and the one that reads it.
* The **original filename** is what the uploader's own file was called. It is
  stored in the database (attachments.original_filename), shown nowhere as a
  path, and used for the browser's save-as name and the sample-name hooks of the
  stub mode. It is plain text from the client: cleaned here, never used to build
  a path.

Files stored before the column existed are called ``<uuid>_<original name>`` on
disk; ``legacy_original_name`` recovers the name from such a path.
"""
from __future__ import annotations

import re
import unicodedata
import uuid
from pathlib import PurePosixPath

from app.services.documents import PDF

_EXTENSIONS = {
    PDF: ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

# Control characters, and the bidirectional override / embedding / isolate
# characters that make a name display in a different order than it is spelled
# ("reportfdp.exe" shown as "reportexe.pdf"). The plain left-to-right and
# right-to-left marks stay: Hebrew names use them legitimately.
_UNWANTED = re.compile("[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]")
_UUID_PREFIX = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}_")

MAX_NAME_CHARS = 200


def extension_for(media_type: str) -> str:
    return _EXTENSIONS.get(media_type, "")


def stored_filename(media_type: str) -> str:
    """A new on-disk name: a UUID and the extension for `media_type`."""
    return f"{uuid.uuid4()}{extension_for(media_type)}"


def clean_original_filename(raw: str | None, media_type: str) -> str:
    """The uploader's file name, made safe to keep and to show.

    Directory parts (either kind of slash) are dropped, control and bidi
    override characters removed, the text put in NFC form, and an over-long name
    shortened from the middle of its stem so the extension survives. A name
    with nothing usable left becomes ``upload`` plus the media type's extension.
    """
    name = unicodedata.normalize("NFC", (raw or "").replace("\\", "/"))
    name = PurePosixPath(name).name
    name = _UNWANTED.sub("", name).strip()
    if name in ("", ".", ".."):
        return f"upload{extension_for(media_type)}"
    if len(name) > MAX_NAME_CHARS:
        suffix = PurePosixPath(name).suffix
        if len(suffix) > 16:
            suffix = ""
        name = name[: MAX_NAME_CHARS - len(suffix)] + suffix
    return name


def legacy_original_name(file_path: str) -> str:
    """The original name of a file stored before the column existed: the last
    component of its path without the ``<uuid>_`` prefix upload used to add."""
    name = PurePosixPath(file_path.replace("\\", "/")).name
    return _UUID_PREFIX.sub("", name, count=1)


def source_name(attachment) -> str:
    """The uploaded file's own name, for display and for the stub-mode name hooks.

    Reads the original_filename column; a row that has none (older than the
    column, or built by hand) falls back to its path, as before."""
    stored = getattr(attachment, "original_filename", None)
    if stored:
        return stored
    return legacy_original_name(attachment.file_path)
