from app.services.instrument_types import make_key


def _instrument(**over):
    body = {"name": "EM 1", "model": "Talos", "manufacturer": "Thermo", "serial_number": "EM-0001"}
    body.update(over)
    return body


def test_the_seeded_types_exist_after_a_fresh_seed(client):
    types = client.get("/instrument-types").json()
    assert {t["key"]: t["display_name"] for t in types} == {
        "flow_cytometer": "Flow cytometer",
        "electron_microscope": "Electron microscope",
        "imagestream": "ImageStream",
        "mass_spectrometer": "Mass spectrometer",
        "pcr_machine": "PCR machine",
    }
    # The key of each added type is what make_key derives from its name.
    assert all(t["key"] == "flow_cytometer" or t["key"] == make_key(t["display_name"]) for t in types)


def test_seeding_again_keeps_what_people_changed_and_adds_what_is_missing(client, db_session):
    from app import models
    from app.services.instrument_types import ensure_default_types

    db_session.query(models.InstrumentType).filter_by(key="pcr_machine").delete()
    db_session.query(models.InstrumentType).filter_by(key="imagestream").one().display_name = "ImageStream (renamed)"
    db_session.commit()
    ensure_default_types(db_session)
    ensure_default_types(db_session)  # idempotent
    names = {t.key: t.display_name for t in db_session.query(models.InstrumentType).all()}
    assert names["pcr_machine"] == "PCR machine"
    assert names["imagestream"] == "ImageStream (renamed)"
    assert len(names) == 5


def test_make_key():
    assert make_key("  Electron microscope ") == "electron_microscope"
    assert make_key("!!!") == ""


def test_add_a_type_and_use_it(client):
    created = client.post("/instrument-types", json={"display_name": "Plate reader"})
    assert created.status_code == 201
    assert created.json()["key"] == "plate_reader"
    inst = client.post("/instruments", json=_instrument(instrument_type="plate_reader"))
    assert inst.status_code == 201
    assert inst.json()["instrument_type"] == "plate_reader"


def test_a_seeded_type_can_be_used_straight_away(client):
    inst = client.post("/instruments", json=_instrument(instrument_type="electron_microscope"))
    assert inst.status_code == 201


def test_duplicate_or_empty_type_names_are_refused(client):
    assert client.post("/instrument-types", json={"display_name": "Mass Spectrometer"}).status_code == 409
    assert client.post("/instrument-types", json={"display_name": "Confocal microscope"}).status_code == 201
    assert client.post("/instrument-types", json={"display_name": "Confocal  microscope"}).status_code == 409
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
        SimpleNamespace(manufacturer="BD", instrument_type="flow_cytometer", model="FACSAria III"),
        SimpleNamespace(manufacturer="Thermo", instrument_type="electron_microscope", model="Talos"),
    ]
    prompt = classification.build_classify_prompt(fleet)
    assert "BD FACSAria III (flow_cytometer)" in prompt and "Thermo Talos (electron_microscope)" in prompt
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


# ---------- blank required text is refused (create and update) ----------

_BLANKS = ["", "   ", "\t\n"]


@pytest.mark.parametrize("field,label", [("name", "Name"), ("model", "Model"), ("serial_number", "Serial number")])
@pytest.mark.parametrize("blank", _BLANKS)
def test_creating_with_a_blank_required_field_is_refused(client, field, label, blank):
    resp = client.post("/instruments", json=_instrument(**{field: blank}))
    assert resp.status_code == 422
    assert f"{label} cannot be blank" in resp.text
    assert all(i["serial_number"] != "EM-0001" for i in client.get("/instruments").json())


@pytest.mark.parametrize("field,label", [("name", "Name"), ("model", "Model"), ("serial_number", "Serial number")])
@pytest.mark.parametrize("blank", _BLANKS)
def test_updating_a_required_field_to_blank_is_refused_and_changes_nothing(client, field, label, blank):
    created = client.post("/instruments", json=_instrument()).json()
    resp = client.patch(f"/instruments/{created['id']}", json={field: blank})
    assert resp.status_code == 422
    assert f"{label} cannot be blank" in resp.text
    assert client.get(f"/instruments/{created['id']}").json()[field] == created[field]


def test_required_text_is_trimmed_on_create_and_update(client):
    created = client.post(
        "/instruments", json=_instrument(name="  EM 9 ", model=" Talos  ", serial_number=" EM-0009 ")
    ).json()
    assert (created["name"], created["model"], created["serial_number"]) == ("EM 9", "Talos", "EM-0009")
    patched = client.patch(f"/instruments/{created['id']}", json={"model": "  Talos L120C "}).json()
    assert patched["model"] == "Talos L120C"


def test_omitting_a_field_on_update_still_leaves_it_alone(client):
    created = client.post("/instruments", json=_instrument()).json()
    patched = client.patch(f"/instruments/{created['id']}", json={"institution": "Test University", "location": "Room 2"}).json()
    assert patched["name"] == created["name"] and patched["location"] == "Room 2"


def test_exactly_one_type_is_the_default_and_it_is_the_flow_cytometer(client):
    types = client.get("/instrument-types").json()
    defaults = [t for t in types if t["is_default"]]
    assert [t["key"] for t in defaults] == ["flow_cytometer"]
    assert defaults[0]["display_name"] == "Flow cytometer"


def test_an_instrument_without_a_type_gets_the_default(client):
    res = client.post("/instruments", json={"name": "Plain", "model": "PlainModel", "manufacturer": "Acme", "serial_number": "DEF-0001"})
    assert res.status_code == 201
    assert res.json()["instrument_type"] == "flow_cytometer"
