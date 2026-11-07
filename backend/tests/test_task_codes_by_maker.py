"""A printed task code is one maker's coding scheme: it decides the report type only for
that maker's documents (services/classification.py), and the generic templates carry no
maker's wording (seed_templates.py)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas import ClassificationGuess
from app.seed_templates import TEMPLATE_ROWS
from app.services import classification
from app.services.classification import _apply_task_code, report_type_from_task_code, task_code_scheme

# ---------- the scheme follows the maker ----------


@pytest.mark.parametrize("maker", ["BD", "bd", "Becton Dickinson", "BD Biosciences"])
def test_bd_and_its_other_names_use_bds_codes(client, db_session, maker):
    assert task_code_scheme(db_session, maker) == "BD"


@pytest.mark.parametrize("maker", ["Cytek Biosciences", "Beckman Coulter", "Unknown Co", "", None])
def test_other_or_unknown_makers_have_no_code_scheme(client, db_session, maker):
    assert task_code_scheme(db_session, maker) is None


def test_a_renamed_bd_maker_still_uses_bds_codes(client, db_session):
    from app import models
    from app.services.manufacturers import ensure_default_makers

    bd = db_session.query(models.Manufacturer).filter_by(name="BD").one()
    bd.name = "BD Life Sciences Inc"
    bd.aliases = [a for a in bd.aliases if a != "BD Life Sciences"]
    db_session.commit()
    ensure_default_makers(db_session)  # puts "BD" back among its other names
    assert task_code_scheme(db_session, "BD Life Sciences Inc") == "BD"


def test_a_code_means_something_only_in_its_makers_scheme():
    assert report_type_from_task_code("T113", "BD").value == "repair"
    assert report_type_from_task_code("T113").value == "repair"  # BD's is the default scheme
    assert report_type_from_task_code("T113", None) is None
    assert report_type_from_task_code("T113", "Cytek Biosciences") is None


def test_another_makers_t113_is_not_read_as_a_repair():
    model_guess = ClassificationGuess(value="preventive_maintenance", confidence=0.5)
    data = {"task_code": "T113", "task_code_confidence": 0.99}
    guess, source = _apply_task_code(model_guess, data, "x.pdf", None)
    assert source == "model" and guess == model_guess
    guess, source = _apply_task_code(model_guess, data, "x.pdf", "BD")
    assert source == "task_code" and guess.value == "repair"


# ---------- through the live read ----------


class _Messages:
    def __init__(self, tool_input):
        self._input = tool_input

    def create(self, **kwargs):
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=self._input)])


def _live(tmp_path, monkeypatch, db, fleet_maker, answer_extra):
    pdf = tmp_path / "scan.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    answer = {
        "instrument_model": "Unit X",
        "instrument_confidence": 0.95,
        "report_type": "preventive_maintenance",
        "report_type_confidence": 0.5,
        "task_code": "T113",
        "task_code_confidence": 0.99,
        **answer_extra,
    }
    client = SimpleNamespace(messages=_Messages(answer))
    monkeypatch.setattr(classification, "_get_client", lambda: client)
    fleet = [SimpleNamespace(model="Unit X", manufacturer=fleet_maker, instrument_type="flow_cytometer")]
    return classification._live_classify(db, SimpleNamespace(file_path=str(pdf)), fleet)


def test_a_bd_unit_with_a_known_code_takes_the_codes_type(tmp_path, monkeypatch, client, db_session):
    read = _live(tmp_path, monkeypatch, db_session, "BD", {})
    assert read.report_type.value == "repair" and read.report_type_source == "task_code"


def test_a_bd_unit_typed_under_another_name_still_does(tmp_path, monkeypatch, client, db_session):
    read = _live(tmp_path, monkeypatch, db_session, "Becton Dickinson", {})
    assert read.report_type_source == "task_code"


def test_another_makers_unit_ignores_the_code_and_keeps_the_models_judgment(tmp_path, monkeypatch, client, db_session):
    read = _live(tmp_path, monkeypatch, db_session, "Cytek Biosciences", {})
    assert read.report_type_source == "model"
    assert read.report_type.value == "preventive_maintenance" and read.report_type.confidence == 0.5


def test_a_document_not_in_the_fleet_uses_the_maker_the_model_detected(tmp_path, monkeypatch, client, db_session):
    other = {"instrument_model": "(not in the fleet)", "detected_manufacturer": "Cytek"}
    assert _live(tmp_path, monkeypatch, db_session, "BD", other).report_type_source == "model"
    bd = {"instrument_model": "(not in the fleet)", "detected_manufacturer": "BD Biosciences"}
    assert _live(tmp_path, monkeypatch, db_session, "Cytek Biosciences", bd).report_type_source == "task_code"


# ---------- the generic templates ----------


def test_generic_templates_name_no_maker_in_their_field_notes():
    for _report_type, model, fields in TEMPLATE_ROWS:
        if model is not None:
            continue
        for f in fields:
            assert "BD" not in (f.get("notes") or ""), (_report_type, f["name"])
