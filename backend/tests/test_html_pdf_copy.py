"""The PDF copy of an HTML report (headless Chromium, scripts and network off).

Skipped when no Chromium can be launched (set HTML_PDF_CHROMIUM_PATH, or `playwright install chromium`).
"""
from __future__ import annotations

import io

import pytest
from pypdf import PdfReader

from app.services import html_pdf

REPORT = (
    "<!DOCTYPE html><html><head><meta charset='utf-8'><title>Service report</title></head><body>"
    "<h1>Service report</h1><table><tr><td>Serial number</td><td>QQ12345</td></tr></table>"
    "<p>Work performed: replaced the pump.</p>"
    "<script>document.write('SCRIPT-RAN-MARKER')</script>"
    "<img src='http://example.invalid/pixel.png'><iframe src='file:///etc/hostname'></iframe>"
    "</body></html>"
).encode()


@pytest.fixture(scope="module")
def chromium_ok():
    try:
        html_pdf.render_html_to_pdf(b"<html><body>probe</body></html>")
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"no headless Chromium available: {str(e).splitlines()[0] if str(e) else e}")


def _text(pdf_bytes: bytes) -> str:
    return "\n".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf_bytes)).pages)


def test_renders_a_pdf_without_running_scripts_or_reading_files(chromium_ok):
    pdf = html_pdf.render_html_to_pdf(REPORT)
    assert pdf.startswith(b"%PDF-")
    text = _text(pdf)
    assert "Serial number" in text and "QQ12345" in text
    assert "SCRIPT-RAN-MARKER" not in text
    import socket

    assert socket.gethostname() not in text  # the file:// iframe was refused


def test_hebrew_page_renders(chromium_ok):
    html = "<html dir='rtl'><head><meta charset='utf-8'></head><body><p>דוח שירות מספר סידורי AB1234</p></body></html>".encode()
    assert len(PdfReader(io.BytesIO(html_pdf.render_html_to_pdf(html))).pages) == 1


def _upload(client):
    report = client.post("/reports", json={}).json()
    return client.post(f"/reports/{report['id']}/attachments", files={"file": ("r.html", REPORT, "text/html")}).json()["id"]


def test_pages_come_from_the_pdf_copy_and_the_original_is_kept(client, chromium_ok):
    attachment_id = _upload(client)
    assert client.get(f"/attachments/{attachment_id}/pages").json() == {"page_count": 1}
    page = client.get(f"/attachments/{attachment_id}/pages/1")
    assert page.status_code == 200 and page.headers["content-type"] == "image/png"
    assert client.get(f"/attachments/{attachment_id}/file").content == REPORT  # download: the original HTML
    inline = client.get(f"/attachments/{attachment_id}/file?inline=1")
    assert inline.headers["content-type"] == "application/pdf" and inline.content.startswith(b"%PDF-")
    words = client.get(f"/attachments/{attachment_id}/pages/1/words").json()
    assert words["has_text"] is True and any(w["text"] == "QQ12345" for w in words["words"])


def test_without_chromium_the_text_view_is_used(client, monkeypatch):
    def broken(_: bytes) -> bytes:
        raise RuntimeError("no browser")

    monkeypatch.setattr(html_pdf, "render_html_to_pdf", broken)
    attachment_id = _upload(client)
    assert client.get(f"/attachments/{attachment_id}/pages").json() == {"page_count": 1, "kind": "text"}
    assert client.get(f"/attachments/{attachment_id}/pages/1").status_code == 404
    inline = client.get(f"/attachments/{attachment_id}/file?inline=1")
    assert inline.headers["content-type"].startswith("text/plain")
