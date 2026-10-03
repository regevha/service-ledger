"""What the app accepts as a scanned original, and how each kind reaches Claude.

The upload box has always accepted images as well as PDFs, but both live calls
sent every file as a `document` block labelled "application/pdf", so a JPEG or
PNG scan could not be read. Nothing checked file type or size on upload
either. See app/services/documents.py.
"""
from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

from app.config import get_settings
from app.services import classification, extraction
from app.services.documents import UnsupportedDocumentError, claude_content_block, detect_media_type
from app.services.errors import ClassificationError, ExtractionError

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"0" * 32
GIF = b"GIF89a" + b"0" * 32
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"0" * 24
PDF_BYTES = b"%PDF-1.4 x"


# ---------- type detection ----------


@pytest.mark.parametrize(
    "data, expected",
    [
        (PDF_BYTES, "application/pdf"),
        (b"\n\n  junk before header\n%PDF-1.7\n", "application/pdf"),
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (GIF, "image/gif"),
        (WEBP, "image/webp"),
        (b"<html><script>alert(1)</script></html>", None),
        (b"PK\x03\x04 a zip or docx", None),
        (b"", None),
    ],
)
def test_detect_media_type_reads_the_bytes(data, expected):
    assert detect_media_type(data) == expected


def test_a_pdf_goes_to_claude_as_a_document_block_and_a_picture_as_an_image_block(tmp_path):
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(PDF_BYTES)
    png = tmp_path / "b.png"
    png.write_bytes(PNG)

    pdf_block = claude_content_block(pdf)
    png_block = claude_content_block(png)

    assert pdf_block["type"] == "document"
    assert pdf_block["source"]["media_type"] == "application/pdf"
    assert base64.b64decode(pdf_block["source"]["data"]) == PDF_BYTES
    assert png_block["type"] == "image"
    assert png_block["source"]["media_type"] == "image/png"
    assert base64.b64decode(png_block["source"]["data"]) == PNG


def test_the_block_type_follows_the_bytes_not_the_file_name(tmp_path):
    mislabelled = tmp_path / "scan.pdf"  # a photo someone renamed
    mislabelled.write_bytes(JPEG)
    assert claude_content_block(mislabelled)["source"]["media_type"] == "image/jpeg"


def test_an_unsupported_stored_file_is_refused(tmp_path):
    odd = tmp_path / "x.pdf"
    odd.write_bytes(b"not a document at all")
    with pytest.raises(UnsupportedDocumentError):
        claude_content_block(odd)


# ---------- the live calls send the right block ----------


class _FakeMessages:
    def __init__(self, response):
        self._response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


def _fake_client(tool_input):
    response = SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=tool_input)])
    return SimpleNamespace(messages=_FakeMessages(response))


def _sent_blocks(client):
    return client.messages.calls[0]["messages"][0]["content"]


def test_live_classify_sends_a_png_scan_as_an_image_block(tmp_path, monkeypatch):
    scan = tmp_path / "scan.png"
    scan.write_bytes(PNG)
    client = _fake_client(
        {"instrument_model": "LSRFortessa", "instrument_confidence": 0.9, "report_type": "repair", "report_type_confidence": 0.9}
    )
    monkeypatch.setattr(classification, "_get_client", lambda: client)

    classification._live_classify(None, SimpleNamespace(file_path=str(scan)), [SimpleNamespace(model="LSRFortessa")])

    first = _sent_blocks(client)[0]
    assert first["type"] == "image"
    assert first["source"]["media_type"] == "image/png"


def test_live_extract_sends_a_jpeg_scan_as_an_image_block(tmp_path, monkeypatch):
    scan = tmp_path / "scan.jpg"
    scan.write_bytes(JPEG)
    template = SimpleNamespace(field_schema={"fields": [{"name": "note", "type": "text", "unit": None, "notes": None}]})
    client = _fake_client({"note": "ok", "note__confidence": 0.9, "report_date": "", "report_date__confidence": 0.0})
    monkeypatch.setattr(extraction, "_get_client", lambda: client)

    extraction._live_extract(SimpleNamespace(file_path=str(scan)), template)

    first = _sent_blocks(client)[0]
    assert first["type"] == "image"
    assert first["source"]["media_type"] == "image/jpeg"


def test_live_calls_report_an_unreadable_stored_file_as_their_own_error(tmp_path, monkeypatch):
    odd = tmp_path / "x.pdf"
    odd.write_bytes(b"not a document at all")
    monkeypatch.setattr(classification, "_get_client", lambda: _fake_client({}))
    monkeypatch.setattr(extraction, "_get_client", lambda: _fake_client({}))
    attachment = SimpleNamespace(file_path=str(odd))

    with pytest.raises(ClassificationError, match="cannot read it"):
        classification._live_classify(None, attachment, [SimpleNamespace(model="LSRFortessa")])
    with pytest.raises(ExtractionError, match="cannot read it"):
        extraction._live_extract(attachment, SimpleNamespace(field_schema={"fields": []}))


# ---------- upload validation ----------


def _upload(client, name, data, content_type):
    report = client.post("/reports", json={}).json()
    return report, client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, content_type)})


@pytest.mark.parametrize("name, data, claimed, stored", [
    ("scan.png", PNG, "image/png", "image/png"),
    ("photo.jpg", JPEG, "image/jpeg", "image/jpeg"),
    ("scan.gif", GIF, "image/gif", "image/gif"),
    ("scan.webp", WEBP, "image/webp", "image/webp"),
    # A browser or script can claim any type; the stored one comes from the bytes.
    ("report.pdf", PDF_BYTES, "application/octet-stream", "application/pdf"),
    ("report.pdf", PDF_BYTES, "text/html", "application/pdf"),
])
def test_upload_accepts_pdfs_and_images_and_records_the_real_type(client, name, data, claimed, stored):
    _, resp = _upload(client, name, data, claimed)
    assert resp.status_code == 201
    assert resp.json()["file_type"] == stored


def test_an_uploaded_scan_is_served_back_with_its_real_type(client):
    _, resp = _upload(client, "x.pdf", PDF_BYTES, "text/html")
    download = client.get(f"/attachments/{resp.json()['id']}/file")
    assert download.headers["content-type"] == "application/pdf"


@pytest.mark.parametrize("name, data", [
    ("notes.txt", b"just some text"),
    ("page.html", b"<html><script>alert(1)</script></html>"),
    ("sheet.xlsx", b"PK\x03\x04 zip container"),
    ("iphone.heic", b"\x00\x00\x00\x18ftypheic"),
    ("renamed.pdf", b"this is not a pdf"),
])
def test_upload_refuses_other_file_types_with_a_clear_message(client, name, data):
    report, resp = _upload(client, name, data, "application/pdf")
    assert resp.status_code == 415
    assert "PDF" in resp.json()["detail"] and "PNG" in resp.json()["detail"]
    # Nothing was attached or written.
    assert client.get(f"/reports/{report['id']}").json()["attachments"] == []


def test_upload_refuses_an_empty_file(client):
    _, resp = _upload(client, "empty.pdf", b"", "application/pdf")
    assert resp.status_code == 422
    assert "empty" in resp.json()["detail"]


def test_upload_enforces_separate_size_limits_for_pdfs_and_images(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "max_pdf_upload_bytes", 100)
    monkeypatch.setattr(settings, "max_image_upload_bytes", 40)

    report, too_big_pdf = _upload(client, "big.pdf", PDF_BYTES + b"0" * 200, "application/pdf")
    assert too_big_pdf.status_code == 413
    assert "PDF" in too_big_pdf.json()["detail"] and "limit" in too_big_pdf.json()["detail"]

    _, big_image = _upload(client, "big.png", PNG + b"0" * 20, "image/png")
    assert big_image.status_code == 413
    assert "image" in big_image.json()["detail"]

    # Under the limit still goes through (the same 60-byte image is over the
    # image limit but a 60-byte PDF is not over the PDF one).
    _, small_pdf = _upload(client, "small.pdf", PDF_BYTES + b"0" * 50, "application/pdf")
    assert small_pdf.status_code == 201
