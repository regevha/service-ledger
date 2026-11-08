"""The helpers that keep the uploader's file name apart from the stored name
(services/attachment_names.py), and the migration that backfills the column."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import attachment_names as names


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("scan.pdf", "scan.pdf"),
        ("Scans/2024/report.pdf", "report.pdf"),
        ("..\\..\\etc\\evil.pdf", "evil.pdf"),  # a Windows path from an old browser
        ("C:\\Users\\x\\scan.pdf", "scan.pdf"),
        ("/abs/path/x.pdf", "x.pdf"),
        ("  padded.pdf  ", "padded.pdf"),
        ("דוח.pdf", "דוח.pdf"),
        ("", "upload.pdf"),
        (None, "upload.pdf"),
        (".", "upload.pdf"),
        ("..", "upload.pdf"),
        ("a/", "a"),  # pathlib drops a trailing slash
        ("a\x00b\x1fc\u202ed.pdf", "abcd.pdf"),  # control and bidi override characters
    ],
)
def test_clean_original_filename(raw, expected):
    assert names.clean_original_filename(raw, "application/pdf") == expected


def test_an_unusable_name_keeps_the_extension_of_the_detected_type():
    assert names.clean_original_filename("", "image/jpeg") == "upload.jpg"


def test_a_long_name_is_shortened_but_keeps_its_extension():
    result = names.clean_original_filename("x" * 500 + ".pdf", "application/pdf")
    assert len(result) == names.MAX_NAME_CHARS and result.endswith(".pdf")


def test_the_left_to_right_and_right_to_left_marks_survive():
    assert names.clean_original_filename("דוח\u200f.pdf", "application/pdf") == "דוח\u200f.pdf"


def test_the_stored_name_is_ascii_and_has_the_detected_extension():
    stored = names.stored_filename("application/pdf")
    assert stored.isascii() and stored.endswith(".pdf") and stored != names.stored_filename("application/pdf")


def test_legacy_names_lose_only_the_uuid_prefix():
    prefix = "0b1c2d3e-1111-4222-8333-444455556666"
    assert names.legacy_original_name(f"/data/attachments/r/{prefix}_שירות_1.pdf") == "שירות_1.pdf"
    assert names.legacy_original_name(f"{prefix}_a_b.pdf") == "a_b.pdf"  # later underscores stay
    assert names.legacy_original_name("/storage/x/scan_A47291.pdf") == "scan_A47291.pdf"  # no uuid prefix, nothing stripped


def test_source_name_prefers_the_column_and_falls_back_to_the_path():
    assert names.source_name(SimpleNamespace(original_filename="mine.pdf", file_path="/d/x.pdf")) == "mine.pdf"
    assert names.source_name(SimpleNamespace(original_filename=None, file_path="/d/scan_B.pdf")) == "scan_B.pdf"
    assert names.source_name(SimpleNamespace(file_path="/d/scan_C.pdf")) == "scan_C.pdf"  # an object without the attribute


def test_the_migrations_backfill_gives_the_same_name_as_the_helper():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0012_attachment_filename.py"
    spec = importlib.util.spec_from_file_location("migration_0010", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    prefix = "0b1c2d3e-1111-4222-8333-444455556666"
    for file_path in (f"/data/attachments/r/{prefix}_שירות_1.pdf", "/storage/x/scan_A47291.pdf", f"C:\\x\\{prefix}_a.pdf"):
        assert migration._original_name(file_path) == names.legacy_original_name(file_path)
