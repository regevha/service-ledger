"""GET /attachments/{id}/field-locations and the locator behind it: the page positions of a report's values."""
from __future__ import annotations

import io

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app import models
from app.services.field_locator import FieldToLocate, locate_fields
from tests.conftest import TestSessionLocal

_H = A4[1]


def _pdf(lines: list[tuple[int, int, str]]) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 10)
    for x, y, text in lines:
        c.drawString(x, _H - y, text)
    c.save()
    return buf.getvalue()


FORM = [
    (50, 80, "Instrument model: FACSAria III"),
    (50, 100, "Service date: 14 Sep 2026"),
    (50, 120, "Laser delay 29.40 us"),
    (50, 140, "Sheath pressure 29.40 psi"),
    (50, 160, "Notes: replaced the nozzle O-ring and"),
    (50, 172, "cleaned the fluidics lines."),
    (50, 200, "Count 4"),
    (50, 215, "Other 4"),
]


def _file(tmp_path, data=None):
    path = tmp_path / "form.pdf"
    path.write_bytes(data or _pdf(FORM))
    return path


def test_a_value_is_found_and_the_box_surrounds_it(tmp_path):
    out = locate_fields(_file(tmp_path), [FieldToLocate("model", "Instrument model", "FACSAria III")])
    assert out.has_text and out.page_count == 1
    loc = out.fields["model"]
    assert (loc.page, loc.matches, loc.ambiguous, loc.source) == (1, 1, False, "text")
    r = loc.rects[0]
    # Drawn at x=50pt on an A4 page, 80pt from the top.
    assert 0.2 < r.x < 0.3 and 0.08 < r.y < 0.11 and 0 < r.w < 0.4 and 0 < r.h < 0.03


def test_the_same_number_written_differently_and_a_date_in_iso_form(tmp_path):
    out = locate_fields(
        _file(tmp_path),
        [FieldToLocate("laser", "Laser delay", "29.4"), FieldToLocate("date", "Service date", "2026-09-14")],
    )
    assert out.fields["laser"].matches == 2
    assert "date" in out.fields and out.fields["date"].source == "text"


def test_the_label_picks_between_two_matches(tmp_path):
    out = locate_fields(
        _file(tmp_path),
        [FieldToLocate("laser", "Laser delay", "29.40"), FieldToLocate("sheath", "Sheath pressure", "29.40")],
    )
    laser, sheath = out.fields["laser"], out.fields["sheath"]
    assert not laser.ambiguous and not sheath.ambiguous
    assert laser.rects[0].y < sheath.rects[0].y  # each got its own line, not the same one twice


def test_a_value_with_nothing_to_tell_matches_apart_is_flagged(tmp_path):
    out = locate_fields(_file(tmp_path), [FieldToLocate("x", "Unrelated", "4")])
    assert out.fields["x"].ambiguous and out.fields["x"].matches == 2


def test_a_value_that_wraps_gets_one_box_per_line(tmp_path):
    value = "replaced the nozzle O-ring and cleaned the fluidics lines."
    out = locate_fields(_file(tmp_path), [FieldToLocate("notes", "Notes", value)])
    assert len(out.fields["notes"].rects) == 2


def test_a_value_not_on_the_page_has_no_box_unless_the_template_gives_one(tmp_path):
    spot = {"page": 1, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.04}
    out = locate_fields(
        _file(tmp_path),
        [FieldToLocate("a", "A", "not written anywhere"), FieldToLocate("b", "B", "not written anywhere", spot)],
    )
    assert "a" not in out.fields
    assert out.fields["b"].source == "template" and out.fields["b"].rects[0].x == 0.1


def test_the_same_words_are_not_given_to_two_fields(tmp_path):
    out = locate_fields(
        _file(tmp_path), [FieldToLocate("one", "Instrument model", "FACSAria"), FieldToLocate("two", "Other", "FACSAria")]
    )
    assert "one" in out.fields and "two" not in out.fields


def test_a_blank_boolean_or_table_value_is_skipped(tmp_path):
    out = locate_fields(
        _file(tmp_path),
        [FieldToLocate("a", "A", ""), FieldToLocate("b", "B", True), FieldToLocate("c", "C", [{"x": 1}]), FieldToLocate("d", "D", None)],
    )
    assert out.fields == {}


def test_a_pdf_without_text_has_no_text_flag(tmp_path):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.rect(50, 50, 100, 100, fill=1)
    c.save()
    out = locate_fields(_file(tmp_path, buf.getvalue()), [FieldToLocate("a", "A", "x")])
    assert out.has_text is False and out.fields == {}


def _report_with_pdf(client, original, current, report_date=None):
    with TestSessionLocal() as db:
        template = db.query(models.ReportTemplate).first()
        names = [f["name"] for f in template.field_schema["fields"]]
        report = models.Report(template_id=template.id, status=models.ReportStatus.in_review, extracted_fields=current, original_fields=original, report_date=report_date)
        db.add(report)
        db.commit()
        report_id = str(report.id)
    att = client.post(f"/reports/{report_id}/attachments", files={"file": ("form.pdf", _pdf(FORM), "application/pdf")}).json()
    return att["id"], names


def test_endpoint_uses_the_first_reading_for_a_field_that_was_corrected(client):
    from datetime import date

    with TestSessionLocal() as db:
        names = [f["name"] for f in db.query(models.ReportTemplate).first().field_schema["fields"]]
    key = names[0]
    att_id, _ = _report_with_pdf(client, {key: "FACSAria III"}, {key: "corrected by hand"}, date(2026, 9, 14))
    body = client.get(f"/attachments/{att_id}/field-locations").json()
    assert body["has_text"] is True and body["page_count"] == 1
    assert key in body["fields"]
    assert body["fields"][key]["page"] == 1 and body["fields"][key]["rects"]
    assert "report_date" in body["fields"]


def test_endpoint_on_an_image_says_there_is_no_text(client):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    with TestSessionLocal() as db:
        report = models.Report(status=models.ReportStatus.draft, extracted_fields={})
        db.add(report)
        db.commit()
        rid = str(report.id)
    r = client.post(f"/reports/{rid}/attachments", files={"file": ("a.png", png, "image/png")})
    if r.status_code == 201:
        body = client.get(f"/attachments/{r.json()['id']}/field-locations").json()
        assert body == {"has_text": False, "page_count": 1, "fields": {}}


def test_endpoint_unknown_attachment_is_404(client):
    import uuid

    assert client.get(f"/attachments/{uuid.uuid4()}/field-locations").status_code == 404


def test_a_corrected_value_is_found_when_the_first_reading_is_not_on_the_page(tmp_path):
    out = locate_fields(
        _file(tmp_path),
        [FieldToLocate("model", "Instrument model", "an invented value", None, "FACSAria III")],
    )
    assert out.fields["model"].source == "text"
