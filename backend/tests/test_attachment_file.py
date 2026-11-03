"""Tests for GET /attachments/{id}/file — serving the original scanned
document back to the report screen (added after noticing, while testing the
demo build, that a finalized report had no way back to the scan it came
from: upload_attachment wrote the file to disk and recorded its path, but
nothing ever served it back out).
"""
from __future__ import annotations

import unicodedata
import uuid
from pathlib import Path
from urllib.parse import unquote

from app import models


def test_downloaded_file_matches_the_uploaded_bytes_and_content_type(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    original_bytes = b"%PDF-1.4 fake scan bytes for download test"

    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("aria_repair_2026.pdf", original_bytes, "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()

    download = client.get(f"/attachments/{attachment['id']}/file")
    assert download.status_code == 200
    assert download.content == original_bytes
    assert download.headers["content-type"] == "application/pdf"
    # The file on disk is named by a generated UUID (see upload_attachment) —
    # the download should hand back the technician's own original filename.
    assert "aria_repair_2026.pdf" in download.headers["content-disposition"]


def test_the_file_is_an_attachment_by_default_and_inline_when_asked_for_display(client):
    # An <iframe> stays blank for an attachment response, so the translation
    # review asks for ?inline=1 (found 2026-10-16 with the Cytek PDF).
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    original_bytes = b"%PDF-1.4 fake scan bytes for inline test"
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("cytek_scan.pdf", original_bytes, "application/pdf")},
    ).json()
    url = f"/attachments/{attachment['id']}/file"

    default = client.get(url)
    assert default.headers["content-disposition"].startswith("attachment")
    assert "x-content-type-options" not in default.headers

    shown = client.get(url, params={"inline": "1"})
    assert shown.status_code == 200
    assert shown.content == original_bytes  # the same bytes either way
    assert shown.headers["content-type"] == "application/pdf"
    assert shown.headers["content-disposition"].startswith("inline")
    assert "cytek_scan.pdf" in shown.headers["content-disposition"]
    assert shown.headers["x-content-type-options"] == "nosniff"

    assert client.get(url, params={"inline": "0"}).headers["content-disposition"].startswith("attachment")


def test_downloading_a_nonexistent_attachment_returns_404(client):
    response = client.get(f"/attachments/{uuid.uuid4()}/file")
    assert response.status_code == 404


def test_downloading_when_the_file_is_missing_from_disk_returns_404(client):
    """A stale attachment row (file deleted or moved out from under it)
    should be a clean 404, not a 500."""
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("will_be_deleted.pdf", b"%PDF-1.4 short-lived", "application/pdf")},
    )
    attachment = upload.json()

    stored_path = client.get(f"/reports/{report['id']}").json()["attachments"][0]
    # ReportOut.attachments doesn't expose file_path by accident — it's the
    # real schema field, useful here to find the file on disk to delete it.
    Path(stored_path["file_path"]).unlink()

    response = client.get(f"/attachments/{attachment['id']}/file")
    assert response.status_code == 404


def test_uploading_a_filename_with_a_slash_no_longer_500s_and_stays_inside_report_dir(client):
    """Regression test for a file-handling bug found during a security review
    (proof-of-concept upload against a live instance): upload_attachment used
    to build the on-disk path as report_dir / f"{uuid}_{file.filename}" with
    the client-supplied filename completely unsanitized. Any filename
    containing "/" — plausible from a nested-folder drag-and-drop, or trivial
    for a scripted client to send — embedded that slash as an extra path
    segment mkdir() never created, so write_bytes() raised an unhandled
    FileNotFoundError (a hard 500). It never actually achieved a path-
    traversal write even with "../" segments (the "<uuid>_" prefix glued onto
    the filename happens to turn a leading ".." into a literal, nonexistent
    directory name rather than the real parent reference) — but crashing on
    an ordinary-looking upload is a real bug on its own, independent of that."""
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("Scans/2024/report.pdf", b"%PDF-1.4 nested folder name", "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()

    # The slash-bearing directory components are stripped — only the
    # basename survives — and the file lands inside this report's own
    # attachment directory, never anywhere else.
    stored_path = Path(attachment["file_path"])
    assert attachment["original_filename"] == "report.pdf"
    assert "report" not in stored_path.name  # the uploader's name is not on disk at all
    assert stored_path.suffix == ".pdf"
    assert str(report["id"]) in str(stored_path.parent)  # still landed inside this report's own attachment dir

    download = client.get(f"/attachments/{attachment['id']}/file")
    assert download.status_code == 200
    assert download.content == b"%PDF-1.4 nested folder name"


def test_uploading_a_traversal_looking_filename_stays_inside_report_dir(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("../../etc/evil.pdf", b"%PDF-1.4 traversal attempt", "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()

    stored_path = Path(attachment["file_path"])
    assert attachment["original_filename"] == "evil.pdf"
    assert "evil" not in stored_path.name
    assert str(report["id"]) in str(stored_path.parent)
    assert stored_path.exists()


def test_uploading_with_no_usable_filename_falls_back_to_a_fixed_name(client):
    """An empty filename, or one that's just "." / ".." — Path(...).name
    returns "" for both of the latter — has no real basename to keep; falls
    back to a fixed name rather than producing a stray "<uuid>_" file or
    crashing."""
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("..", b"%PDF-1.4 no real name", "application/pdf")},
    )
    assert upload.status_code == 201
    attachment = upload.json()
    assert attachment["original_filename"] == "upload.pdf"
    assert Path(attachment["file_path"]).suffix == ".pdf"


def test_report_detail_lists_its_attachments(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    attachment = upload.json()

    refreshed = client.get(f"/reports/{report['id']}").json()
    assert len(refreshed["attachments"]) == 1
    assert refreshed["attachments"][0]["id"] == attachment["id"]
    assert refreshed["attachments"][0]["file_type"] == "application/pdf"


def _upload(client, name: str, data: bytes = b"%PDF-1.4 name test") -> dict:
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    response = client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, "application/pdf")})
    assert response.status_code == 201
    return response.json()


def test_a_hebrew_file_name_is_kept_for_the_download_but_never_used_on_disk(client):
    name = "דוח_שירות_מרץ.pdf"
    attachment = _upload(client, name)

    stored = Path(attachment["file_path"])
    assert stored.name.isascii() and stored.suffix == ".pdf"  # nothing the uploader typed is on disk
    assert attachment["original_filename"] == name

    disposition = client.get(f"/attachments/{attachment['id']}/file").headers["content-disposition"]
    assert "filename*=utf-8''" in disposition  # an RFC 5987 name, so Hebrew survives in every browser
    assert unquote(disposition.split("filename*=utf-8''")[1]) == name


def test_a_decomposed_unicode_name_is_stored_in_composed_form(client):
    decomposed = unicodedata.normalize("NFD", "café_scan.pdf")
    attachment = _upload(client, decomposed)
    assert attachment["original_filename"] == unicodedata.normalize("NFC", decomposed)


def test_a_very_long_hebrew_name_no_longer_breaks_the_upload(client):
    # 150 Hebrew letters are 300 bytes in UTF-8: over the 255 byte limit a name
    # on disk used to have to fit, together with its uuid prefix.
    attachment = _upload(client, "א" * 150 + ".pdf")
    assert len(attachment["original_filename"]) == 154
    assert Path(attachment["file_path"]).exists()

    longer = _upload(client, "ב" * 400 + ".pdf")
    assert len(longer["original_filename"]) == 200  # shortened, extension kept
    assert longer["original_filename"].endswith(".pdf")


def test_characters_a_file_share_refuses_are_harmless_because_the_name_is_not_on_disk(client):
    attachment = _upload(client, "a:b?c*d<e>f|g.pdf")
    assert attachment["original_filename"] == "a:b?c*d<e>f|g.pdf"
    assert Path(attachment["file_path"]).exists()


def test_control_and_bidi_override_characters_are_removed_from_the_name(client):
    attachment = _upload(client, "report\u202efdp.exe.pdf")
    assert attachment["original_filename"] == "reportfdp.exe.pdf"


def test_two_uploads_with_the_same_name_do_not_overwrite_each_other(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    paths = set()
    for body in (b"%PDF-1.4 first", b"%PDF-1.4 second"):
        r = client.post(f"/reports/{report['id']}/attachments", files={"file": ("scan.pdf", body, "application/pdf")})
        paths.add(r.json()["file_path"])
    assert len(paths) == 2


def test_an_image_gets_the_extension_of_its_detected_type_not_the_uploaded_one(client):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("photo.pdf", png, "application/pdf")}
    ).json()
    assert Path(attachment["file_path"]).suffix == ".png"
    assert attachment["file_type"] == "image/png"


def test_a_row_from_before_the_column_still_downloads_under_its_original_name(client, db_session):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    legacy = Path(f"/tmp/{uuid.uuid4()}_שירות.pdf")
    legacy.write_bytes(b"%PDF-1.4 legacy")
    row = models.Attachment(report_id=uuid.UUID(report["id"]), file_path=str(legacy), file_type="application/pdf", page_count=1)
    db_session.add(row)
    db_session.commit()
    try:
        disposition = client.get(f"/attachments/{row.id}/file").headers["content-disposition"]
        assert unquote(disposition.split("filename*=utf-8''")[1]) == "שירות.pdf"
    finally:
        legacy.unlink()
