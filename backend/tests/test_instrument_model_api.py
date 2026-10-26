"""Models plan step 2: the model record is the source. Edits follow through to
the instruments' copies and the templates written for the name; merging and
deleting say what moves or refuses."""
from __future__ import annotations

from app import models


def _make_unit(client, serial, model="Zeta Sorter", manufacturer="BD", **extra):
    r = client.post(
        "/instruments",
        json={"name": f"Unit {serial}", "model": model, "serial_number": serial, "manufacturer": manufacturer, **extra},
    )
    assert r.status_code == 201, r.text
    return r.json()


def _model(client, name):
    return next(m for m in client.get("/instrument-models").json() if m["name"] == name)


def _template(client, model, report_type="repair", instrument_type="facs"):
    r = client.post(
        "/report-templates",
        json={
            "instrument_type": instrument_type,
            "report_type": report_type,
            "model": model,
            "fields": [{"name": "summary", "type": "text"}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_list_counts_units_and_templates(client):
    _make_unit(client, "S1")
    _make_unit(client, "S2")
    _template(client, "Zeta Sorter")
    m = _model(client, "Zeta Sorter")
    assert m["unit_count"] == 2 and m["template_count"] == 1 and m["manufacturer"] == "BD"


def test_list_flags_look_alike_names(client):
    _make_unit(client, "S1", model="Zeta Sorter")
    _make_unit(client, "S2", model="ZetaSorter")
    assert _model(client, "Zeta Sorter")["similar_to"] == ["ZetaSorter"]
    assert _model(client, "ZetaSorter")["similar_to"] == ["Zeta Sorter"]


def test_create_and_duplicate_name(client):
    r = client.post("/instrument-models", json={"name": "Quark 9", "manufacturer": "Acme", "service_interval_months": 6})
    assert r.status_code == 201 and r.json()["unit_count"] == 0
    assert client.post("/instrument-models", json={"name": "Quark 9"}).status_code == 409
    assert client.post("/instrument-models", json={"name": "  "}).status_code == 422
    assert client.post("/instrument-models", json={"name": "Q2", "service_interval_months": 0}).status_code == 422
    assert client.post("/instrument-models", json={"name": "Q3", "instrument_type": "nope"}).status_code == 422


def test_rename_updates_units_templates_and_search_text(client, db_session):
    unit = _make_unit(client, "S1")
    t = _template(client, "Zeta Sorter")
    m = _model(client, "Zeta Sorter")
    r = client.patch(f"/instrument-models/{m['id']}", json={"name": "Zeta Sorter II"})
    assert r.status_code == 200 and r.json()["name"] == "Zeta Sorter II"
    assert client.get(f"/instruments/{unit['id']}").json()["model"] == "Zeta Sorter II"
    assert next(x for x in client.get("/report-templates/all").json() if x["id"] == t["id"])["model"] == "Zeta Sorter II"
    db_session.expire_all()
    # No stray record was created by the relink, and the unit still points at the renamed one.
    names = [r.name for r in db_session.query(models.InstrumentModel).all()]
    assert "Zeta Sorter" not in names and names.count("Zeta Sorter II") == 1


def test_rename_to_existing_name_is_refused(client):
    _make_unit(client, "S1", model="Zeta A")
    _make_unit(client, "S2", model="Zeta B")
    assert client.patch(f"/instrument-models/{_model(client, 'Zeta A')['id']}", json={"name": "Zeta B"}).status_code == 409


def test_rename_refused_when_a_template_would_clash(client):
    _make_unit(client, "S1", model="Zeta A")
    _template(client, "Zeta A")
    _template(client, "Zeta Target")  # template exists for a name with no instruments
    r = client.patch(f"/instrument-models/{_model(client, 'Zeta A')['id']}", json={"name": "Zeta Target"})
    assert r.status_code == 409 and "template already exists" in r.json()["detail"]
    assert _model(client, "Zeta A")["unit_count"] == 1


def test_manufacturer_change_follows_to_the_units(client):
    unit = _make_unit(client, "S1")
    m = _model(client, "Zeta Sorter")
    assert client.patch(f"/instrument-models/{m['id']}", json={"manufacturer": "Becton Dickinson"}).status_code == 200
    assert client.get(f"/instruments/{unit['id']}").json()["manufacturer"] == "Becton Dickinson"


def test_type_cannot_change_while_units_exist(client):
    _make_unit(client, "S1")
    m = _model(client, "Zeta Sorter")
    assert client.patch(f"/instrument-models/{m['id']}", json={"instrument_type": "pcr_machine"}).status_code == 409
    empty = client.post("/instrument-models", json={"name": "Empty One"}).json()
    assert client.patch(f"/instrument-models/{empty['id']}", json={"instrument_type": "pcr_machine"}).status_code == 200


def test_service_interval_and_notes_are_editable_and_clearable(client):
    m = client.post("/instrument-models", json={"name": "Quark 9"}).json()
    r = client.patch(f"/instrument-models/{m['id']}", json={"service_interval_months": 12, "notes": "Needs sheath filter"})
    assert r.json()["service_interval_months"] == 12 and r.json()["notes"] == "Needs sheath filter"
    r = client.patch(f"/instrument-models/{m['id']}", json={"service_interval_months": None, "notes": ""})
    assert r.json()["service_interval_months"] is None and r.json()["notes"] is None


def test_delete_refused_with_units_allowed_without(client):
    _make_unit(client, "S1")
    m = _model(client, "Zeta Sorter")
    r = client.delete(f"/instrument-models/{m['id']}")
    assert r.status_code == 409 and "1 instrument still uses" in r.json()["detail"]
    empty = client.post("/instrument-models", json={"name": "Empty One"}).json()
    assert client.delete(f"/instrument-models/{empty['id']}").status_code == 204
    assert client.delete(f"/instrument-models/{empty['id']}").status_code == 404


def test_merge_moves_units_and_templates(client):
    a = _make_unit(client, "S1", model="Zeta Sorter", manufacturer="BD")
    b = _make_unit(client, "S2", model="ZetaSorter", manufacturer="Becton")
    _template(client, "ZetaSorter", report_type="preventive_maintenance")
    src, dst = _model(client, "ZetaSorter"), _model(client, "Zeta Sorter")
    r = client.post(f"/instrument-models/{src['id']}/merge", json={"into_id": dst["id"]})
    assert r.status_code == 200
    assert r.json() == {"moved_instruments": 1, "moved_templates": 1, "into": "Zeta Sorter"}
    assert client.get(f"/instruments/{b['id']}").json()["model"] == "Zeta Sorter"
    assert client.get(f"/instruments/{b['id']}").json()["manufacturer"] == "BD"
    merged = _model(client, "Zeta Sorter")
    assert merged["unit_count"] == 2 and merged["template_count"] == 1
    assert all(m["name"] != "ZetaSorter" for m in client.get("/instrument-models").json())
    assert client.get(f"/instruments/{a['id']}").status_code == 200


def test_merge_refusals(client):
    _make_unit(client, "S1", model="Zeta A")
    _make_unit(client, "S2", model="Zeta B")
    a, b = _model(client, "Zeta A"), _model(client, "Zeta B")
    assert client.post(f"/instrument-models/{a['id']}/merge", json={"into_id": a["id"]}).status_code == 422
    pcr = client.post("/instrument-models", json={"name": "Zeta PCR", "instrument_type": "pcr_machine"}).json()
    assert client.post(f"/instrument-models/{a['id']}/merge", json={"into_id": pcr["id"]}).status_code == 422
    _template(client, "Zeta A")
    _template(client, "Zeta B")
    r = client.post(f"/instrument-models/{a['id']}/merge", json={"into_id": b["id"]})
    assert r.status_code == 409 and "template" in r.json()["detail"]
    assert _model(client, "Zeta A")["unit_count"] == 1  # nothing moved


def test_instrument_cannot_join_a_model_of_another_type(client):
    client.post("/instrument-models", json={"name": "Zeta PCR", "instrument_type": "pcr_machine"})
    r = client.post(
        "/instruments",
        json={"name": "X", "model": "Zeta PCR", "serial_number": "S9", "manufacturer": "BD", "instrument_type": "facs"},
    )
    assert r.status_code == 422
    unit = _make_unit(client, "S1")
    assert client.patch(f"/instruments/{unit['id']}", json={"model": "Zeta PCR"}).status_code == 422
