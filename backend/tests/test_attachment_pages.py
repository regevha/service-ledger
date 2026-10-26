"""GET /attachments/{id}/pages and /pages/{n} — the scan as PNG page images,
for the phone's Fields | Scan switch (Android Chrome cannot show a PDF in an
<iframe>)."""
from __future__ import annotations

import io

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def _two_page_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.drawString(100, 700, "page one")
    c.showPage()
    c.drawString(100, 700, "page two")
    c.showPage()
    c.save()
    return buf.getvalue()


def _upload(client, name, data, content_type):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    r = client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, content_type)})
    assert r.status_code == 201
    return r.json()["id"]


def test_a_pdf_reports_its_page_count_and_renders_each_page_as_png(client):
    att = _upload(client, "scan.pdf", _two_page_pdf(), "application/pdf")
    assert client.get(f"/attachments/{att}/pages").json() == {"page_count": 2}

    res = client.get(f"/attachments/{att}/pages/2", params={"width": 600})
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    img = Image.open(io.BytesIO(res.content))
    assert img.width == 600
    assert img.height > img.width  # A4 portrait
    # the page is not blank: some dark ink was rendered
    assert img.convert("L").getextrema()[0] < 100


def test_pages_outside_the_document_are_404(client):
    att = _upload(client, "scan.pdf", _two_page_pdf(), "application/pdf")
    assert client.get(f"/attachments/{att}/pages/0").status_code == 404
    assert client.get(f"/attachments/{att}/pages/3").status_code == 404


def test_width_is_bounded(client):
    att = _upload(client, "scan.pdf", _two_page_pdf(), "application/pdf")
    assert client.get(f"/attachments/{att}/pages/1", params={"width": 50}).status_code == 422
    assert client.get(f"/attachments/{att}/pages/1", params={"width": 9000}).status_code == 422


def test_an_image_scan_is_one_page_returned_as_stored(client):
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(buf, format="PNG")
    att = _upload(client, "scan.png", buf.getvalue(), "image/png")
    assert client.get(f"/attachments/{att}/pages").json() == {"page_count": 1}
    res = client.get(f"/attachments/{att}/pages/1")
    assert res.status_code == 200
    assert res.content == buf.getvalue()
    assert client.get(f"/attachments/{att}/pages/2").status_code == 404


def test_unknown_attachment_is_404(client):
    missing = "00000000-0000-0000-0000-000000000000"
    assert client.get(f"/attachments/{missing}/pages").status_code == 404
    assert client.get(f"/attachments/{missing}/pages/1").status_code == 404
