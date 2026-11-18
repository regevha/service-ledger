"""GET /attachments/{id}/pages and /pages/{n} — the scan as PNG page images,
for the phone's Fields | Scan switch (Android Chrome cannot show a PDF in an
<iframe>)."""
from __future__ import annotations

import base64
import io
from types import SimpleNamespace

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from app.services import template_drafts


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
    Image.new("RGB", (800, 600), "white").save(buf, format="PNG")
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


def test_template_suggestions_use_one_page_and_filter_unusable_drafts(client, monkeypatch):
    att = _upload(client, "scan.pdf", _two_page_pdf(), "application/pdf")
    monkeypatch.setattr(template_drafts, "enabled", lambda: True)
    monkeypatch.setattr(template_drafts, "get_client", lambda: None)
    source = {"page": 2, "x": 0.2, "y": 0.2, "w": 0.3, "h": 0.2}
    field = {"name": "service_notes", "type": "text", "notes": None, "source": source}

    def response(**kwargs):
        content = kwargs["request_kwargs"]["messages"][0]["content"]
        assert len(content) == 2
        assert content[0]["source"]["media_type"] == "image/png"
        with Image.open(io.BytesIO(base64.b64decode(content[0]["source"]["data"]))) as image:
            assert max(image.size) <= 1600
        assert "Use page number 2" in content[1]["text"]
        fields = [
            field,
            field,
            {**field, "name": "report_date"},
            {**field, "name": "first_page", "source": {**source, "page": 1}},
            {**field, "name": "outside", "source": {**source, "x": 0.9}},
        ]
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input={"fields": fields})])

    monkeypatch.setattr(template_drafts, "call_claude_tool", response)
    res = client.post(f"/attachments/{att}/pages/2/template-field-suggestions")
    assert res.status_code == 200
    assert res.json() == [field]
    assert client.post(f"/attachments/{att}/pages/3/template-field-suggestions").status_code == 404


def test_model_suggestions_respect_stub_mode_and_prompt_review(client, monkeypatch):
    att = _upload(client, "scan.pdf", _two_page_pdf(), "application/pdf")
    url = f"/attachments/{att}/pages/1/template-field-suggestions"
    assert client.post(url).status_code == 503
    monkeypatch.setattr(template_drafts, "enabled", lambda: True)
    monkeypatch.setattr(template_drafts.settings, "view_prompts", True)
    assert client.post(url).status_code == 409


def _filled_form_pdf() -> bytes:
    """A fillable PDF whose typed value lives in a form field, not in the page content."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.acroForm.textfield(
        name="serial", value="WWWWWWWWWWWW", x=100, y=700, width=300, height=40,
        borderWidth=0, fillColor=None, fontSize=24, forceBorder=False,
    )
    c.showPage()
    c.save()
    return buf.getvalue()


def test_a_fillable_forms_typed_values_are_drawn_on_the_page_image(client):
    att = _upload(client, "form.pdf", _filled_form_pdf(), "application/pdf")
    res = client.get(f"/attachments/{att}/pages/1", params={"width": 595})
    assert res.status_code == 200
    img = Image.open(io.BytesIO(res.content)).convert("L")
    # The field sits at y 700..740 of an 842-high page (scale 1 at width 595).
    box = img.crop((100, 842 - 740, 400, 842 - 700))
    assert min(box.getdata()) < 100, "the typed value is missing from the page image"


def test_upload_stores_the_real_page_count(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    sent = client.post(f"/reports/{report['id']}/attachments", files={"file": ("two.pdf", _two_page_pdf(), "application/pdf")})
    assert sent.status_code == 201 and sent.json()["page_count"] == 2
    assert client.get(f"/reports/{report['id']}").json()["attachments"][0]["page_count"] == 2


def test_an_image_is_one_page_and_an_unreadable_pdf_falls_back_to_one(client):
    from app.services.page_text import count_pdf_pages

    buf = io.BytesIO()
    Image.new("RGB", (800, 600), "white").save(buf, "PNG")
    att = _upload(client, "scan.png", buf.getvalue(), "image/png")
    assert client.get(f"/attachments/{att}/pages").json() == {"page_count": 1}
    assert count_pdf_pages(b"%PDF-1.4 this is not a real pdf") == 1
    assert count_pdf_pages(_two_page_pdf()) == 2

def test_draft_read_uses_unsaved_fields_and_leaves_report_untouched(client):
    from app.models import ReportType

    att = _upload(client, "draft-sample.pdf", _two_page_pdf(), "application/pdf")
    templates_before = client.get("/report-templates/all").json()
    reports_before = client.get("/reports").json()
    result = client.post(
        f"/attachments/{att}/template-extraction-preview",
        json={"report_type": ReportType.repair.value, "fields": [{"name": "draft_notes", "type": "text"}]},
    )
    assert result.status_code == 200
    assert set(result.json()["fields"]) == {"draft_notes"}
    assert result.json()["placeholder"] is True
    assert client.get("/report-templates/all").json() == templates_before
    assert client.get("/reports").json() == reports_before
