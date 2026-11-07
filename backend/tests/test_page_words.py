"""GET /attachments/{id}/pages/{n}/words and GET /report-templates/sample-scans —
what the template editor needs to let a person pick fields straight from a PDF."""
from __future__ import annotations

import io

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def _form_pdf() -> bytes:
    """One A4 page: a label and value on one line, a second line below, and a
    far-apart pair on the third line that must not be joined into one word."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 12)
    c.drawString(72, 700, "Laser delay")
    c.drawString(200, 700, "29.40")
    c.drawString(72, 660, "Sheath pressure 4.9 psi")
    c.drawString(72, 620, "Range")
    c.drawString(420, 620, "24.0")
    c.showPage()
    c.drawString(72, 700, "second page")
    c.showPage()
    c.save()
    return buf.getvalue()


def _blank_pdf() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.showPage()
    c.save()
    return buf.getvalue()


def _upload(client, name, data, content_type):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    r = client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, content_type)})
    assert r.status_code == 201
    return r.json()["id"], report["id"]


def _words(client, att, page=1):
    res = client.get(f"/attachments/{att}/pages/{page}/words")
    assert res.status_code == 200
    return res.json()


def test_a_pdf_page_lists_its_words_with_positions(client):
    att, _ = _upload(client, "form.pdf", _form_pdf(), "application/pdf")
    body = _words(client, att)
    assert body["page"] == 1 and body["has_text"] is True
    texts = [w["text"] for w in body["words"]]
    assert texts == ["Laser", "delay", "29.40", "Sheath", "pressure", "4.9", "psi", "Range", "24.0"]


def test_boxes_are_fractions_of_the_page_from_the_top_left(client):
    att, _ = _upload(client, "form.pdf", _form_pdf(), "application/pdf")
    words = {w["text"]: w for w in _words(client, att)["words"]}
    laser = words["Laser"]
    # A4 is 595 x 842 points; the baseline of "Laser" is 700 pt up from the bottom, so about 142 pt from the top.
    assert abs(laser["x"] - 72 / 595) < 0.01
    assert 0.15 < laser["y"] < 0.18
    assert 0 < laser["w"] < 0.1 and 0 < laser["h"] < 0.03
    for w in words.values():
        assert 0 <= w["x"] <= 1 and 0 <= w["y"] <= 1
        assert w["x"] + w["w"] <= 1.001 and w["y"] + w["h"] <= 1.001
    # the value sits to the right of its label on the same line, and the next line is lower
    assert words["29.40"]["x"] > words["delay"]["x"]
    assert words["Sheath"]["y"] > laser["y"]


def test_words_on_one_line_share_a_line_number_and_lower_lines_count_up(client):
    att, _ = _upload(client, "form.pdf", _form_pdf(), "application/pdf")
    words = {w["text"]: w for w in _words(client, att)["words"]}
    assert words["Laser"]["line"] == words["delay"]["line"] == words["29.40"]["line"] == 0
    assert words["Sheath"]["line"] == words["psi"]["line"] == 1
    assert words["Range"]["line"] == words["24.0"]["line"] == 2


def test_the_second_page_has_its_own_words(client):
    att, _ = _upload(client, "form.pdf", _form_pdf(), "application/pdf")
    assert [w["text"] for w in _words(client, att, 2)["words"]] == ["second", "page"]


def test_a_page_outside_the_document_is_404(client):
    att, _ = _upload(client, "form.pdf", _form_pdf(), "application/pdf")
    assert client.get(f"/attachments/{att}/pages/0/words").status_code == 404
    assert client.get(f"/attachments/{att}/pages/3/words").status_code == 404


def test_a_pdf_with_no_text_has_no_words_and_says_so(client):
    att, _ = _upload(client, "blank.pdf", _blank_pdf(), "application/pdf")
    assert _words(client, att) == {"page": 1, "has_text": False, "words": []}


def test_an_image_scan_has_no_words(client):
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(buf, format="PNG")
    att, _ = _upload(client, "scan.png", buf.getvalue(), "image/png")
    assert _words(client, att) == {"page": 1, "has_text": False, "words": []}
    assert client.get(f"/attachments/{att}/pages/2/words").status_code == 404


def test_an_unknown_attachment_is_404(client):
    assert client.get("/attachments/00000000-0000-0000-0000-000000000000/pages/1/words").status_code == 404


def test_sample_scans_lists_stored_pdfs_newest_first_and_skips_images(client):
    first, first_report = _upload(client, "older.pdf", _form_pdf(), "application/pdf")
    buf = io.BytesIO()
    Image.new("RGB", (40, 30), "white").save(buf, format="PNG")
    _upload(client, "photo.png", buf.getvalue(), "image/png")
    second, second_report = _upload(client, "newer.pdf", _blank_pdf(), "application/pdf")

    rows = client.get("/report-templates/sample-scans").json()
    assert [r["attachment_id"] for r in rows] == [second, first]
    assert [r["file_name"] for r in rows] == ["newer.pdf", "older.pdf"]
    assert [r["report_id"] for r in rows] == [second_report, first_report]
    assert {r["reason"] for r in rows} == {"Another report"}


def test_sample_scans_offers_the_same_report_type_and_model_first(client, db_session):
    from app import models

    old, old_report = _upload(client, "match.pdf", _form_pdf(), "application/pdf")
    _upload(client, "other.pdf", _blank_pdf(), "application/pdf")  # newer, but not a match

    template = db_session.query(models.ReportTemplate).filter_by(report_type=models.ReportType.repair).first()
    instrument = db_session.query(models.Instrument).first()
    report = db_session.get(models.Report, old_report)
    report.template_id = template.id
    report.instrument_id = instrument.id
    db_session.commit()

    rows = client.get(
        "/report-templates/sample-scans", params={"report_type": "repair", "model": instrument.model}
    ).json()
    assert rows[0]["attachment_id"] == old
    assert rows[0]["reason"] == "Same report type and model"
    assert rows[0]["instrument_serial_number"] == instrument.serial_number
    assert rows[1]["reason"] == "Another report"

    only_type = client.get("/report-templates/sample-scans", params={"report_type": "repair"}).json()
    assert only_type[0]["reason"] == "Same report type"


def test_sample_scans_respects_the_limit(client):
    for i in range(3):
        _upload(client, f"f{i}.pdf", _blank_pdf(), "application/pdf")
    assert len(client.get("/report-templates/sample-scans", params={"limit": 2}).json()) == 2
    assert client.get("/report-templates/sample-scans", params={"limit": 0}).status_code == 422
