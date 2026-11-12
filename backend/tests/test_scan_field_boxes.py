"""Boxes for scans and photos: the extraction call asks the model where it read each value, the answer is
checked and stored, and GET /attachments/{id}/field-locations serves it as an approximate position."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import models
from app.services import extraction
from app.services.extraction_prompt import _box_key, _build_extract_tool
from tests.conftest import TestSessionLocal
from tests.test_live_claude_parsing import _FakeClient, _template, _tool_use_response

_ANSWER = {
    "fault_description": "No see events",
    "fault_description__confidence": 0.9,
    "labor_hours": 1.5,
    "labor_hours__confidence": 0.9,
    "retest_result": "pass",
    "retest_result__confidence": 0.9,
}


def _run(tmp_path, monkeypatch, answer, file_type="image/png", name="scan.png"):
    path = tmp_path / name
    path.write_bytes(b"\x89PNG fake")
    fake = _FakeClient(response=_tool_use_response({**_ANSWER, **answer}))
    monkeypatch.setattr(extraction, "_get_client", lambda: fake)
    monkeypatch.setattr(extraction, "claude_content_block", lambda p: {"type": "image", "source": {}}, raising=False)
    monkeypatch.setattr(extraction, "source_block", lambda a: {"type": "image", "source": {}})
    attachment = SimpleNamespace(file_path=str(path), file_type=file_type)
    return extraction._live_extract(attachment, _template()), fake


def test_the_tool_only_asks_for_boxes_when_told_to():
    fields = [{"name": "a", "type": "text"}]
    assert _box_key("a") not in _build_extract_tool(fields)["input_schema"]["properties"]
    props = _build_extract_tool(fields, with_boxes=True)["input_schema"]["properties"]
    assert _box_key("a") in props and _box_key("report_date") in props
    assert _box_key("a") not in _build_extract_tool(fields, True)["input_schema"]["required"]


def test_a_photo_gets_boxes_and_the_good_ones_are_kept(tmp_path, monkeypatch):
    result, fake = _run(
        tmp_path,
        monkeypatch,
        {
            "fault_description__box": {"page": 1, "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.05},
            "labor_hours__box": {"page": 1, "x": 0.1, "y": 0.9, "w": 0.5, "h": 0.5},  # runs off the page: trimmed
            "retest_result__box": {"page": 1, "x": 2, "y": 0.2, "w": 0.1, "h": 0.1},  # outside the page: dropped
        },
    )
    assert result.field_boxes["fault_description"] == {"page": 1, "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.05}
    assert result.field_boxes["labor_hours"]["h"] == pytest.approx(0.1)
    assert "retest_result" not in result.field_boxes
    assert _box_key("fault_description") in fake.messages.calls[0]["tools"][0]["input_schema"]["properties"]
    assert "Positions" in fake.messages.calls[0]["messages"][0]["content"][1]["text"]


@pytest.mark.parametrize("bad", ["top left", {"page": "x", "x": 0, "y": 0, "w": 1, "h": 1}, {"page": 1}, {"page": 0, "x": 0, "y": 0, "w": 1, "h": 1}, {"page": 1, "x": 0.1, "y": 0.1, "w": 0, "h": 0.1}])
def test_unusable_boxes_are_ignored_not_fatal(tmp_path, monkeypatch, bad):
    result, _ = _run(tmp_path, monkeypatch, {"fault_description__box": bad})
    assert result.field_boxes == {}
    assert result.extracted_fields["fault_description"] == "No see events"


def test_a_translated_document_is_not_boxed(tmp_path, monkeypatch):
    path = tmp_path / "scan.png"
    path.write_bytes(b"x")
    fake = _FakeClient(response=_tool_use_response(_ANSWER))
    monkeypatch.setattr(extraction, "_get_client", lambda: fake)
    monkeypatch.setattr(extraction, "source_block", lambda a: {"type": "text", "text": "translated"})
    result = extraction._live_extract(SimpleNamespace(file_path=str(path), file_type="image/png"), _template())
    assert result.field_boxes is None
    assert _box_key("fault_description") not in fake.messages.calls[0]["tools"][0]["input_schema"]["properties"]


# ---------- the endpoint ----------


def _png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (60, 80), "white").save(buf, "PNG")
    return buf.getvalue()


def _blank_pdf() -> bytes:
    import io

    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.showPage()
    c.save()
    return buf.getvalue()


def _upload(client, name, data, mime, boxes, other=False):
    with TestSessionLocal() as db:
        report = models.Report(status=models.ReportStatus.in_review, extracted_fields={})
        db.add(report)
        db.commit()
        rid = report.id
    r = client.post(f"/reports/{rid}/attachments", files={"file": (name, data, mime)})
    assert r.status_code == 201, r.text
    att = r.json()["id"]
    with TestSessionLocal() as db:
        db.get(models.Report, rid).field_boxes = {
            "attachment_id": "00000000-0000-0000-0000-000000000000" if other else att,
            "boxes": boxes,
        }
        db.commit()
    return att


BOX = {"fault": {"page": 1, "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.05}}


def test_a_photo_is_served_with_the_models_boxes(client):
    att = _upload(client, "a.png", _png(), "image/png", {**BOX, "late": {"page": 3, "x": 0, "y": 0, "w": 1, "h": 1}})
    body = client.get(f"/attachments/{att}/field-locations").json()
    assert body["has_text"] is False
    assert list(body["fields"]) == ["fault"]  # the box on a page that does not exist is left out
    f = body["fields"]["fault"]
    assert f["source"] == "model" and f["page"] == 1 and f["rects"] == [{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.05}]


def test_a_scanned_pdf_is_served_with_the_models_boxes(client):
    att = _upload(client, "scan.pdf", _blank_pdf(), "application/pdf", BOX)
    body = client.get(f"/attachments/{att}/field-locations").json()
    assert body["has_text"] is False and body["fields"]["fault"]["source"] == "model"


def test_boxes_from_another_document_of_the_report_are_not_used(client):
    att = _upload(client, "a.png", _png(), "image/png", BOX, other=True)
    assert client.get(f"/attachments/{att}/field-locations").json()["fields"] == {}
