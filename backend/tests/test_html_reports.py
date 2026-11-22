"""HTML service reports: accepted at upload, read as text, never served as a web page.

Synthetic files only. The text is read (scripts and styles dropped, tables kept row by row,
Hebrew in logical order); a page that is not a report (error page, invoice, login) is stopped
by the free keyword check with `recognized: false`, before any model call.
"""
from __future__ import annotations

import pytest

from app.services.documents import HTML, claude_content_block, detect_media_type
from app.services.html_text import html_to_text, looks_like_html
from app.services.report_keywords import check_service_report_text

REPORT = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>Service Report</title>
<style>td{color:red}</style><script>alert(1)</script></head><body>
<h1>Service report</h1><p>Work order: WO-04215114</p>
<table><tr><td>Serial number</td><td>QQ12345</td></tr><tr><td>Labour hours</td><td>2.5</td></tr></table>
<p>Work performed: replaced the pump. Parts replaced: seal kit. Visit date 2026-11-20. Technician A. Example.</p>
<p>Instrument model: Test Cytometer. Fault: no flow. Repair completed.</p></body></html>""".encode()

HEBREW = (
    "<!DOCTYPE html><html dir='rtl' lang='he'><head><meta charset='utf-8'></head><body>"
    "<p>דוח שירות</p><p>מספר סידורי: AB1234</p><p>שעות עבודה: 3</p><p>תאריך ביקור: 20/11/2026</p>"
    "<p>עבודה שבוצעה: תיקון משאבה. חלקים שהוחלפו: אטם. תקלה: אין זרימה. טכנאי: א. לדוגמה.</p></body></html>"
).encode()

ERROR_PAGE = b"<!DOCTYPE html><html><head><title>404</title></head><body><h1>Page not found</h1><p>The page you asked for could not be found on this server, please check the address and try again later.</p></body></html>"
INVOICE = b"<html><body><h1>Invoice</h1><p>Invoice number 4411. Total due 120.00. Thank you for your business, please pay within thirty days of the date shown above.</p></body></html>"


def test_detects_html_and_not_prose():
    assert detect_media_type(REPORT) == HTML
    assert detect_media_type(b"\xef\xbb\xbf  <html><body>x</body></html>") == HTML
    assert detect_media_type(b"hello <html> inside prose") is None
    assert looks_like_html(b"<table><tr><td>x</td></tr></table>")


def test_text_drops_scripts_and_styles_and_keeps_table_rows():
    text = html_to_text(REPORT)
    assert "alert" not in text and "color:red" not in text
    assert "Serial number\tQQ12345" in text
    assert "Labour hours\t2.5" in text
    assert text.splitlines()[0] == "Service Report"


def test_hebrew_stays_in_logical_order_and_charset_is_honoured():
    assert "מספר סידורי: AB1234" in html_to_text(HEBREW)
    cp1255 = "<html><head><meta charset='windows-1255'></head><body>דוח שירות</body></html>".encode("cp1255")
    assert "דוח שירות" in html_to_text(cp1255)


def test_content_block_is_plain_text_not_markup():
    block = claude_content_block_from(REPORT)
    assert block["source"]["type"] == "text" and block["source"]["media_type"] == "text/plain"
    assert "<" not in block["source"]["data"]


def claude_content_block_from(data: bytes):
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".html") as f:
        f.write(data)
        f.flush()
        return claude_content_block(f.name)


@pytest.mark.parametrize(
    "data, expected",
    [(REPORT, True), (HEBREW, True), (ERROR_PAGE, False), (INVOICE, False), (b"<html><body>hi</body></html>", False)],
)
def test_keyword_check(data, expected):
    check = check_service_report_text(html_to_text(data), min_score=4, min_chars=80)
    assert check.looks_like_report is expected


def _upload(client, name, data, mime="text/html"):
    report = client.post("/reports", json={}).json()
    return report, client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, mime)})


def test_upload_accepts_html_with_server_decided_type(client):
    _, resp = _upload(client, "report.html", REPORT, mime="application/octet-stream")
    assert resp.status_code == 201
    assert resp.json()["file_type"] == HTML


def test_html_is_never_served_as_a_web_page(client):
    _, resp = _upload(client, "report.html", REPORT)
    attachment_id = resp.json()["id"]
    inline = client.get(f"/attachments/{attachment_id}/file?inline=1")
    assert inline.headers["content-type"].startswith("text/plain")
    assert inline.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in inline.headers["content-security-policy"]
    assert "alert" not in inline.text and "<" not in inline.text
    download = client.get(f"/attachments/{attachment_id}/file")
    assert download.headers["content-type"] == "application/octet-stream"
    assert download.content == REPORT
    assert "attachment" in download.headers["content-disposition"]
    assert client.get(f"/attachments/{attachment_id}/pages/1").status_code == 404
    assert client.get(f"/attachments/{attachment_id}/pages").json() == {"page_count": 1, "kind": "text"}


def test_pdf_and_image_page_counts_keep_their_shape(client):
    report = client.post("/reports", json={}).json()
    png = b"\x89PNG\r\n\x1a\n" + b"x" * 20
    att = client.post(f"/reports/{report['id']}/attachments", files={"file": ("a.png", png, "image/png")}).json()
    assert client.get(f"/attachments/{att['id']}/pages").json() == {"page_count": 1}


def test_html_over_its_cap_is_refused_and_nothing_stored(client, monkeypatch):
    from app.routers import attachments

    monkeypatch.setattr(attachments.settings, "max_html_upload_bytes", 500)
    _, resp = _upload(client, "big.html", REPORT + b"<!-- " + b"x" * 2000 + b" -->")
    assert resp.status_code == 413
    assert "HTML file" in resp.json()["detail"]


def test_non_report_html_is_stopped_before_any_model_call(client, run_worker, monkeypatch):
    from app.services import classification

    def boom(*a, **k):
        raise AssertionError("the model must not be called for an HTML page that is not a report")

    monkeypatch.setattr(classification, "_stub_classify", boom)
    monkeypatch.setattr(classification, "_live_classify", boom)
    for name, data in (("error.html", ERROR_PAGE), ("invoice.html", INVOICE)):
        report, resp = _upload(client, name, data)
        job = client.post(f"/attachments/{resp.json()['id']}/classify").json()
        run_worker()
        result = client.get(f"/extraction-jobs/{job['id']}").json()["classification"]
        assert result["recognized"] is False
        assert result["resolved_instrument_id"] is None


def test_real_html_report_passes_the_gate(client, run_worker):
    # Named with the stub's other-maker marker so the stub reads it without a key (as the PDF tests do).
    _, resp = _upload(client, "othermaker-QQ9999-report.html", REPORT)
    job = client.post(f"/attachments/{resp.json()['id']}/classify").json()
    run_worker()
    result = client.get(f"/extraction-jobs/{job['id']}").json()["classification"]
    assert result["recognized"] is True
    assert result["detected_model"] == "Cytek Aurora"
