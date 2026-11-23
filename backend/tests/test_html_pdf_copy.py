"""The PDF copy of an HTML report (headless Chromium, scripts and network off).

Skipped locally when no Chromium can be launched (set HTML_PDF_CHROMIUM_PATH, or `playwright install chromium`).
When the CI environment variable is set (GitHub Actions sets CI=true) a missing Chromium is a failure instead: the
workflow installs it, and a silent skip there would leave the PDF copy untested without anyone noticing.
"""
from __future__ import annotations

import io
import os

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


def _chromium_missing(reason: str) -> None:
    """Skip the tests that need Chromium, or fail them when running on CI."""
    if os.environ.get("CI", "").lower() in ("true", "1"):
        pytest.fail(f"CI is set but no headless Chromium can be launched: {reason}", pytrace=False)
    pytest.skip(f"no headless Chromium available: {reason}")


@pytest.fixture(scope="module")
def chromium_ok():
    try:
        html_pdf.render_html_to_pdf(b"<html><body>probe</body></html>")
    except Exception as e:  # noqa: BLE001
        _chromium_missing(str(e).splitlines()[0] if str(e) else repr(e))


def test_a_missing_chromium_fails_on_ci(monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(pytest.fail.Exception, match="no headless Chromium can be launched"):
        _chromium_missing("Executable doesn't exist")


def test_a_missing_chromium_skips_off_ci(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(pytest.skip.Exception, match="no headless Chromium available"):
        _chromium_missing("Executable doesn't exist")


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
    text = _text(html_pdf.render_html_to_pdf(html))
    assert "AB1234" in text and any("\u05d0" <= c <= "\u05ea" for c in text)  # Hebrew letters, not empty boxes


def test_no_request_reaches_the_network(chromium_ok):
    """Every kind of fetch a page can start is pointed at a local listener, which must see no connection."""
    import socket
    import threading

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(16)
    srv.settimeout(0.3)
    hits: list[int] = []
    stop = threading.Event()

    def accept():
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
                hits.append(1)
                conn.close()
            except OSError:
                continue

    t = threading.Thread(target=accept, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{srv.getsockname()[1]}"
    html = (
        f"<html><head><link rel='preconnect' href='{base}'><link rel='dns-prefetch' href='{base}'>"
        f"<link rel='prefetch' href='{base}/p'><link rel='stylesheet' href='{base}/s.css'>"
        f"<meta http-equiv='refresh' content='0;url={base}/r'><style>body{{background:url({base}/bg.png)}}</style></head>"
        f"<body><p>Serial QQ999</p><img src='{base}/i.png'><iframe src='{base}/f'></iframe>"
        f"<form action='{base}/post'><input></form><a href='{base}/a'>link</a></body></html>"
    ).encode()
    try:
        assert "QQ999" in _text(html_pdf.render_html_to_pdf(html))
        t.join(1.0)
    finally:
        stop.set()
        srv.close()
    assert hits == []


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
    def broken(_path):
        raise RuntimeError("no browser")

    monkeypatch.setattr(html_pdf, "_render_in_child", broken)
    attachment_id = _upload(client)
    assert client.get(f"/attachments/{attachment_id}/pages").json() == {"page_count": 1, "kind": "text"}


def test_a_failed_render_is_not_retried_on_every_request(client, monkeypatch):
    calls = []

    def broken(_path):
        calls.append(1)
        raise RuntimeError("no browser")

    monkeypatch.setattr(html_pdf, "_render_in_child", broken)
    attachment_id = _upload(client)
    for _ in range(4):
        client.get(f"/attachments/{attachment_id}/pages")
        client.get(f"/attachments/{attachment_id}/file?inline=1")
    assert len(calls) == 1


def test_field_locations_work_on_the_pdf_copy(client, chromium_ok):
    attachment_id = _upload(client)
    r = client.get(f"/attachments/{attachment_id}/field-locations")
    assert r.status_code == 200
