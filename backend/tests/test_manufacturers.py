"""Makers as records: one row per maker however it was typed (services/manufacturers.py)."""
from app import models
from app.services.manufacturers import canonical_name, ensure_default_makers, normalize


def _instrument(**over):
    body = {"name": "Unit", "model": "Model X", "manufacturer": "BD", "serial_number": "MK-0001"}
    body.update(over)
    return body


def _names(db):
    return sorted(m.name for m in db.query(models.Manufacturer).all())


def test_the_seed_creates_the_fleet_makers_and_links_every_unit(client, db_session):
    assert {"BD", "Cytek Biosciences", "Beckman Coulter"} <= set(_names(db_session))
    assert db_session.query(models.Instrument).filter(models.Instrument.manufacturer_id.is_(None)).count() == 0
    bd = db_session.query(models.Manufacturer).filter_by(name="BD").one()
    assert "Becton Dickinson" in bd.aliases


def test_a_known_alternative_name_becomes_the_makers_canonical_name(client):
    created = client.post("/instruments", json=_instrument(manufacturer="Becton Dickinson"))
    assert created.status_code == 201
    assert created.json()["manufacturer"] == "BD"


def test_spelling_differences_in_case_spaces_and_punctuation_join_one_maker(client, db_session):
    client.post("/instruments", json=_instrument(model="M1", serial_number="MK-1", manufacturer="Acme  Optics"))
    second = client.post("/instruments", json=_instrument(model="M2", serial_number="MK-2", manufacturer="acme-optics"))
    assert second.json()["manufacturer"] == "Acme Optics"
    assert [n for n in _names(db_session) if "cme" in n] == ["Acme Optics"]


def test_a_new_maker_is_created_from_the_typed_text(client, db_session):
    client.post("/instruments", json=_instrument(manufacturer="Thermo Fisher"))
    maker = db_session.query(models.Manufacturer).filter_by(name="Thermo Fisher").one()
    unit = db_session.query(models.Instrument).filter_by(serial_number="MK-0001").one()
    assert unit.manufacturer_id == maker.id


def test_two_units_of_a_new_maker_in_one_save_share_it(db_session):
    for n in (1, 2):
        db_session.add(models.Instrument(name=f"U{n}", model=f"M{n}", manufacturer="Newco", serial_number=f"NC-{n}"))
    db_session.commit()
    assert db_session.query(models.Manufacturer).filter_by(name="Newco").count() == 1


def test_a_model_record_gets_the_same_maker(client, db_session):
    client.post("/instruments", json=_instrument(manufacturer="BD Biosciences", model="Brand New Model"))
    record = db_session.query(models.InstrumentModel).filter_by(name="Brand New Model").one()
    assert record.manufacturer == "BD"
    assert record.manufacturer_record.name == "BD"


def test_editing_the_manufacturer_text_relinks(client, db_session):
    unit = client.post("/instruments", json=_instrument(model="Solo", manufacturer="Cytek")).json()
    assert unit["manufacturer"] == "Cytek Biosciences"
    got = db_session.get(models.Instrument, unit["id"])
    assert got.manufacturer_record.name == "Cytek Biosciences"


def test_no_manufacturer_stays_empty(db_session):
    db_session.add(models.Instrument(name="U", model="M", manufacturer="   ", serial_number="NM-1"))
    db_session.commit()
    unit = db_session.query(models.Instrument).filter_by(serial_number="NM-1").one()
    assert unit.manufacturer is None and unit.manufacturer_id is None


def test_ensure_default_makers_adds_missing_ones_and_aliases_and_keeps_edits(client, db_session):
    bd = db_session.query(models.Manufacturer).filter_by(name="BD").one()
    bd.aliases = ["My own alias"]
    db_session.query(models.Manufacturer).filter_by(name="Beckman Coulter").update({"name": "Beckman Coulter Inc"})
    db_session.commit()
    ensure_default_makers(db_session)
    ensure_default_makers(db_session)  # idempotent
    db_session.expire_all()
    bd = db_session.query(models.Manufacturer).filter_by(name="BD").one()
    assert "My own alias" in bd.aliases and "Becton Dickinson" in bd.aliases
    names = _names(db_session)
    # A rename is kept and the maker is not created a second time under its known name.
    assert "Beckman Coulter Inc" in names and "Beckman Coulter" not in names
    renamed = db_session.query(models.Manufacturer).filter_by(name="Beckman Coulter Inc").one()
    assert "Beckman Coulter" in renamed.aliases


def test_canonical_name_helper(client, db_session):
    assert canonical_name(db_session, " becton  dickinson ") == "BD"
    assert canonical_name(db_session, "Unknown  Maker") == "Unknown Maker"
    assert canonical_name(db_session, "   ") is None
    assert normalize("Becton, Dickinson") == "bectondickinson"


# --- API ---------------------------------------------------------------------

def test_list_shows_counts(client):
    makers = {m["name"]: m for m in client.get("/manufacturers").json()}
    assert makers["BD"]["instrument_count"] >= 1
    assert makers["BD"]["model_count"] >= 1
    assert "Becton Dickinson" in makers["BD"]["aliases"]


def test_create_a_maker_with_aliases(client):
    res = client.post("/manufacturers", json={"name": "  Zeiss ", "aliases": ["Carl Zeiss", "carl  zeiss", "", "Zeiss"]})
    assert res.status_code == 201
    assert res.json()["name"] == "Zeiss"
    assert res.json()["aliases"] == ["Carl Zeiss"]
    unit = client.post("/instruments", json=_instrument(manufacturer="Carl Zeiss"))
    assert unit.json()["manufacturer"] == "Zeiss"


def test_create_refuses_a_name_or_alias_another_maker_answers_to(client):
    assert client.post("/manufacturers", json={"name": "bd"}).status_code == 409
    assert client.post("/manufacturers", json={"name": "Fresh", "aliases": ["Becton Dickinson"]}).status_code == 409
    assert client.post("/manufacturers", json={"name": "!!!"}).status_code == 422


def test_rename_updates_the_text_on_units_and_models(client, db_session):
    bd = next(m for m in client.get("/manufacturers").json() if m["name"] == "BD")
    res = client.patch(f"/manufacturers/{bd['id']}", json={"name": "BD Biosciences Inc"})
    assert res.status_code == 200
    db_session.expire_all()
    assert db_session.query(models.Instrument).filter_by(manufacturer_id=bd["id"]).first().manufacturer == "BD Biosciences Inc"
    assert db_session.query(models.InstrumentModel).filter_by(manufacturer_id=bd["id"]).first().manufacturer == "BD Biosciences Inc"
    # Typing the old name still finds the maker, now through the alias list only if it was kept there.
    again = client.post("/instruments", json=_instrument(model="Another", serial_number="MK-9", manufacturer="Becton Dickinson"))
    assert again.json()["manufacturer"] == "BD Biosciences Inc"


def test_replace_aliases_and_refuse_a_clash(client):
    makers = {m["name"]: m for m in client.get("/manufacturers").json()}
    ok = client.patch(f"/manufacturers/{makers['Cytek Biosciences']['id']}", json={"aliases": ["Cytek", "Cytek Inc"]})
    assert ok.status_code == 200 and ok.json()["aliases"] == ["Cytek", "Cytek Inc"]
    clash = client.patch(f"/manufacturers/{makers['Cytek Biosciences']['id']}", json={"aliases": ["Beckman"]})
    assert clash.status_code == 409
    clash_name = client.patch(f"/manufacturers/{makers['Cytek Biosciences']['id']}", json={"name": "Beckman Coulter"})
    assert clash_name.status_code == 409


def test_delete_only_an_unused_maker(client):
    makers = {m["name"]: m for m in client.get("/manufacturers").json()}
    assert client.delete(f"/manufacturers/{makers['BD']['id']}").status_code == 409
    new = client.post("/manufacturers", json={"name": "Unused Co"}).json()
    assert client.delete(f"/manufacturers/{new['id']}").status_code == 204
    assert client.delete(f"/manufacturers/{new['id']}").status_code == 404


def test_update_unknown_maker_is_404(client):
    assert client.patch("/manufacturers/00000000-0000-0000-0000-000000000000", json={"name": "X"}).status_code == 404


def test_the_analytics_manufacturer_filter_accepts_any_name_of_the_maker(client, db_session):
    # Old links and saved filters carry "Becton Dickinson"; instruments store "BD".
    by_name = client.get("/analytics/models", params={"manufacturer": "BD"}).json()
    by_alias = client.get("/analytics/models", params={"manufacturer": "Becton Dickinson"}).json()
    assert by_name and by_name == by_alias
    assert client.get("/analytics/models", params={"manufacturer": "Nobody"}).json() == []
