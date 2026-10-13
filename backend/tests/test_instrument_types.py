from app.services.instrument_types import make_key


def _instrument(**over):
    body = {"name": "EM 1", "model": "Talos", "manufacturer": "Thermo", "serial_number": "EM-0001"}
    body.update(over)
    return body


def test_the_first_type_is_the_flow_cytometer(client):
    types = client.get("/instrument-types").json()
    assert [(t["key"], t["display_name"]) for t in types] == [("facs", "Flow cytometer")]


def test_make_key():
    assert make_key("  Electron microscope ") == "electron_microscope"
    assert make_key("!!!") == ""


def test_add_a_type_and_use_it(client):
    created = client.post("/instrument-types", json={"display_name": "Electron microscope"})
    assert created.status_code == 201
    assert created.json()["key"] == "electron_microscope"
    inst = client.post("/instruments", json=_instrument(instrument_type="electron_microscope"))
    assert inst.status_code == 201
    assert inst.json()["instrument_type"] == "electron_microscope"


def test_duplicate_or_empty_type_names_are_refused(client):
    assert client.post("/instrument-types", json={"display_name": "flow Cytometer"}).status_code == 201
    assert client.post("/instrument-types", json={"display_name": "Flow  cytometer"}).status_code == 409
    assert client.post("/instrument-types", json={"display_name": "  "}).status_code == 422


def test_an_unknown_type_is_refused_for_instruments_and_templates(client):
    assert client.post("/instruments", json=_instrument(instrument_type="nope")).status_code == 422
    fields = [{"name": "note", "type": "text"}]
    assert (
        client.post(
            "/report-templates", json={"instrument_type": "nope", "report_type": "repair", "fields": fields}
        ).status_code
        == 422
    )


# ---------- classification uses the matched instrument's type ----------

import pytest  # noqa: E402

from app import models  # noqa: E402
from app.schemas import ClassificationGuess  # noqa: E402
from app.services import classification  # noqa: E402
from app.services.classification import DocumentRead  # noqa: E402
from app.services.errors import ClassificationError  # noqa: E402
from tests.conftest import TestSessionLocal  # noqa: E402

_FIELDS = [{"name": "note", "type": "text"}]


def _upload(client):
    report = client.post("/reports", json={}).json()
    return client.post(
        f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4 x", "application/pdf")}
    ).json()


def _read_for(model, serial):
    return DocumentRead(
        ClassificationGuess(value=model, confidence=0.95),
        ClassificationGuess(value="repair", confidence=0.95),
        ClassificationGuess(value=serial, confidence=0.95),
    )


def test_a_template_is_resolved_for_the_matched_instruments_own_type(client, monkeypatch):
    client.post("/instrument-types", json={"display_name": "Electron microscope"})
    client.post("/instruments", json=_instrument(instrument_type="electron_microscope"))
    em_template = client.post(
        "/report-templates",
        json={"instrument_type": "electron_microscope", "report_type": "repair", "fields": _FIELDS},
    ).json()
    attachment = _upload(client)
    monkeypatch.setattr(classification, "_stub_classify", lambda a, i: _read_for("Talos", "EM-0001"))

    with TestSessionLocal() as db:
        result = classification.classify(db, db.get(models.Attachment, attachment["id"]))

    assert str(result.resolved_template_id) == em_template["id"]
    assert result.resolved_instrument_id is not None


def test_a_type_with_no_template_does_not_borrow_the_flow_cytometer_one(client, monkeypatch):
    client.post("/instrument-types", json={"display_name": "Electron microscope"})
    client.post("/instruments", json=_instrument(instrument_type="electron_microscope"))
    attachment = _upload(client)  # the seeded flow-cytometer repair template exists, the EM has none
    monkeypatch.setattr(classification, "_stub_classify", lambda a, i: _read_for("Talos", "EM-0001"))

    with TestSessionLocal() as db:
        result = classification.classify(db, db.get(models.Attachment, attachment["id"]))

    assert result.resolved_template_id is None
    assert result.resolved_instrument_id is None
    assert result.suggested_instrument_id is not None  # still offered for the manual pick


# ---------- prompts and the no-key refusal ----------


def test_the_classify_prompt_lists_the_fleet_and_is_not_bd_only():
    from types import SimpleNamespace

    fleet = [
        SimpleNamespace(manufacturer="BD", instrument_type="facs", model="FACSAria III"),
        SimpleNamespace(manufacturer="Thermo", instrument_type="electron_microscope", model="Talos"),
    ]
    prompt = classification.build_classify_prompt(fleet)
    assert "BD FACSAria III (facs)" in prompt and "Thermo Talos (electron_microscope)" in prompt
    assert not prompt.startswith("This is a scanned BD Care")
    assert "Work Order Task Code" in prompt  # the BD reading notes are still there


def _text_pdf(text: str) -> bytes:
    from reportlab.pdfgen import canvas
    import io

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.drawString(72, 720, text)
    c.save()
    return buf.getvalue()


def test_without_a_key_a_text_document_from_an_unknown_maker_is_refused(client):
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("b.pdf", _text_pdf("Acme Microscopy field service visit, column alignment"), "application/pdf")},
    ).json()
    with TestSessionLocal() as db:
        with pytest.raises(ClassificationError, match="API key"):
            classification.classify(db, db.get(models.Attachment, attachment["id"]))
