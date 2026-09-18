"""Tests for GET /attachments/{id}/file — serving the original scanned
document back to the report screen (added after noticing, while testing the
demo build, that a finalized report had no way back to the scan it came
from: upload_attachment wrote the file to disk and recorded its path, but
nothing ever served it back out).
"""
from __future__ import annotations

import uuid
from pathlib import Path


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
    # The stored filename on disk is "<uuid>_aria_repair_2026.pdf" (see
    # upload_attachment) — the download should hand back the technician's own
    # original filename, not the UUID-prefixed one on disk.
    assert "aria_repair_2026.pdf" in download.headers["content-disposition"]


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
