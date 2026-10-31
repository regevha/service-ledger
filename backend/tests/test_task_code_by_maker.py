"""Task codes (T111, T107, T113) are BD's own, so they only decide the report
type on a document from BD. Another maker's form may print a code that looks the
same and mean something else; for it, and for a document whose maker is not
known, the model's own judgment decides.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.models import ReportType
from app.services import classification
from app.services.classification import report_type_from_task_code

BD_INSTRUMENT = SimpleNamespace(model="FACSDiscover S8", manufacturer="BD", instrument_type="flow_cytometer")
CYTEK_INSTRUMENT = SimpleNamespace(model="Aurora", manufacturer="Cytek Biosciences", instrument_type="flow_cytometer")


# ---------- the lookup ----------


@pytest.mark.parametrize("maker", ["BD", "bd", "Becton Dickinson", "Becton, Dickinson and Company", "BD Biosciences"])
def test_a_bd_document_maps_its_codes_however_the_maker_is_spelled(maker):
    assert report_type_from_task_code("T113", maker) == ReportType.repair
    assert report_type_from_task_code("T111", maker) == ReportType.preventive_maintenance
    assert report_type_from_task_code("T107", maker) == ReportType.installation_upgrade


@pytest.mark.parametrize("maker", ["Cytek Biosciences", "Beckman Coulter", "Some Other Maker"])
def test_another_makers_lookalike_code_is_not_mapped(maker):
    assert report_type_from_task_code("T113", maker) is None


@pytest.mark.parametrize("maker", [None, "", "   ", 7])
def test_an_unknown_maker_is_not_mapped(maker):
    assert report_type_from_task_code("T113", maker) is None


def test_no_maker_given_means_unknown():
    assert report_type_from_task_code("T113") is None


# ---------- the live call ----------


def _classify(monkeypatch, tmp_path, answer, instruments):
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(b"%PDF-1.4 scan")

    class _Messages:
        def create(self, **kwargs):
            return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=answer)])

    monkeypatch.setattr(classification, "_get_client", lambda: SimpleNamespace(messages=_Messages()))
    return classification._live_classify(None, SimpleNamespace(file_path=str(scan)), instruments)


def _answer(model, **extra):
    return {
        "instrument_model": model,
        "instrument_confidence": 0.97,
        # What the model alone made of the visit.
        "report_type": "preventive_maintenance",
        "report_type_confidence": 0.5,
        "task_code": "T113",
        "task_code_confidence": 0.96,
        "work_order_number": "WO-1",
        **extra,
    }


def test_a_bd_instrument_still_maps_its_task_code(monkeypatch, tmp_path):
    read = _classify(monkeypatch, tmp_path, _answer("FACSDiscover S8"), [BD_INSTRUMENT, CYTEK_INSTRUMENT])
    assert (read.report_type.value, read.report_type_source) == ("repair", "task_code")


def test_a_non_bd_instrument_with_a_lookalike_code_is_left_to_the_model(monkeypatch, tmp_path):
    read = _classify(monkeypatch, tmp_path, _answer("Aurora"), [BD_INSTRUMENT, CYTEK_INSTRUMENT])
    assert (read.report_type.value, read.report_type.confidence) == ("preventive_maintenance", 0.5)
    assert read.report_type_source == "model"


def test_a_model_outside_the_fleet_uses_the_detected_maker(monkeypatch, tmp_path):
    bd = _classify(
        monkeypatch, tmp_path,
        _answer("(not in the fleet)", detected_manufacturer="Becton Dickinson"),
        [CYTEK_INSTRUMENT],
    )
    assert bd.report_type_source == "task_code" and bd.report_type.value == "repair"

    other = _classify(
        monkeypatch, tmp_path,
        _answer("(not in the fleet)", detected_manufacturer="Sysmex"),
        [CYTEK_INSTRUMENT],
    )
    assert other.report_type_source == "model" and other.report_type.value == "preventive_maintenance"


def test_an_unknown_maker_falls_through_to_the_model(monkeypatch, tmp_path):
    read = _classify(monkeypatch, tmp_path, _answer("(not in the fleet)"), [CYTEK_INSTRUMENT])
    assert read.report_type_source == "model" and read.report_type.value == "preventive_maintenance"


def test_the_fleet_instruments_maker_wins_over_the_detected_one(monkeypatch, tmp_path):
    # The model says BD, but the matched fleet instrument is Cytek's: Cytek's
    # (empty) table applies, not BD's.
    read = _classify(monkeypatch, tmp_path, _answer("Aurora", detected_manufacturer="BD"), [CYTEK_INSTRUMENT])
    assert read.report_type_source == "model"
