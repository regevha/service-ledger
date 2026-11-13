"""Where a stored scan lives, relative to the storage root.

`attachments.file_path` holds the path *inside* the storage root ("<report id>/<uuid>.pdf"),
not the full path on disk, so the same database works after the storage moves to another mount
or another machine (a restore, a different Azure Files share). Code reads `Attachment.file_path`
as before and gets the full path: the model joins the root at read time (models/reports.py).
A path that is not under the root (a row someone pointed elsewhere) is kept as it is.
"""
from __future__ import annotations

from pathlib import Path

from app.config import get_settings


def storage_root() -> Path:
    return get_settings().attachment_storage_path


def to_stored(path: str, root: Path | None = None) -> str:
    """The form kept in the database: relative to the root, forward slashes; unchanged when outside it."""
    root = root or storage_root()
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path


def to_absolute(stored: str, root: Path | None = None) -> str:
    """The full path of a stored value. An absolute value is returned unchanged; a relative one is joined
    to the root, and refused if it would climb out of it."""
    if Path(stored).is_absolute():
        return stored
    root = root or storage_root()
    full = (root / stored).resolve()
    if not full.is_relative_to(root.resolve()):
        raise ValueError(f"Stored path {stored!r} leaves the storage root")
    return str(root / stored)
