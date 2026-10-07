"""Matching the serial number printed on a document to a fleet instrument.

A model alone cannot tell two units of one model apart, so before this a fleet
with several units of a model always fell through to a manual pick. The
document does print the instrument's serial number; classification now reads
it, matches it to exactly one fleet instrument, and uses that instrument when
the read is confident and agrees with the model. See
app/services/classification.py (classify, match_serial).
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.schemas import ClassificationGuess
from app.services import classification
from app.services.classification import _parse_serial_read, _stub_serial_read, match_serial

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


def _fleet(*pairs):
    return [SimpleNamespace(model=m, serial_number=s) for m, s in pairs]


def _guess(value, confidence=0.97):
    return ClassificationGuess(value=value, confidence=confidence)


# ---------- unit: reading and matching ----------


@pytest.mark.parametrize("printed", ["A47291", "a47291", " A-47291 ", "A 47 291", "a.47291"])
def test_match_serial_ignores_case_spacing_and_punctuation(printed):
    fleet = _fleet(("FACSAria III", "A47291"), ("LSRFortessa", "R647794E6092"))
    assert match_serial(_guess(printed), fleet) is fleet[0]


def test_match_serial_is_none_when_nothing_matches_or_nothing_was_read():
    fleet = _fleet(("FACSAria III", "A47291"))
    assert match_serial(_guess("ZZ99"), fleet) is None
    assert match_serial(None, fleet) is None
    assert match_serial(_guess("---"), fleet) is None


def test_match_serial_refuses_to_guess_between_look_alike_serials():
    fleet = _fleet(("FACSAria III", "AB-1"), ("FACSAria III", "AB1"))
    assert match_serial(_guess("ab1"), fleet) is None


@pytest.mark.parametrize("answer", [{}, {"instrument_serial": ""}, {"instrument_serial": "N/A"}, {"instrument_serial": " n/a "}, {"instrument_serial": None}, {"instrument_serial": 12}])
def test_a_missing_or_not_applicable_serial_is_not_a_read(answer):
    assert _parse_serial_read(answer, "x.pdf") is None


def test_a_serial_read_carries_its_confidence_and_a_bad_confidence_means_unsure():
    read = _parse_serial_read({"instrument_serial": " MP6651580000057 ", "instrument_serial_confidence": 0.91}, "x.pdf")
    assert (read.value, read.confidence) == ("MP6651580000057", 0.91)
    unsure = _parse_serial_read({"instrument_serial": "A47291", "instrument_serial_confidence": "high"}, "x.pdf")
    assert unsure.confidence == 0.0
    assert _parse_serial_read({"instrument_serial": "A47291", "instrument_serial_confidence": 7}, "x.pdf").confidence == 1.0


def test_the_stub_reads_a_serial_only_from_the_file_name():
    fleet = _fleet(("FACSAria III", "A47291"), ("LSRFortessa", "R647794E6092"))
    assert _stub_serial_read("storage/ab/cd_scan_a47291_final.pdf", fleet).value == "A47291"
    assert _stub_serial_read("storage/ab/cd_scan.pdf", fleet) is None
    # The directory part (random uuids) never counts.
    assert _stub_serial_read("storage/A47291/cd_scan.pdf", fleet) is None


# ---------- through the API ----------


def _add_second_aria(client, serial="A50002"):
    resp = client.post("/instruments", json={"name": "Aria Annex", "model": "FACSAria III", "serial_number": serial})
    assert resp.status_code == 201
    return resp.json()


def _classify(client, run_worker, monkeypatch, *, model="FACSAria III", serial=None, serial_confidence=0.97, model_confidence=0.99):
    monkeypatch.setattr(
        classification,
        "_stub_classify",
        lambda attachment, instruments: (
            _guess(model, model_confidence),
            _guess("preventive_maintenance", 0.99),
            _guess(serial, serial_confidence) if serial is not None else None,
        ),
    )
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()
    body = client.get(f"/extraction-jobs/{job['id']}").json()
    return client.get(f"/reports/{report['id']}").json(), body["classification"]


def _instrument_id(client, serial):
    return next(i["id"] for i in client.get("/instruments").json() if i["serial_number"] == serial)


def test_a_serial_picks_the_right_unit_when_a_model_has_several(client, run_worker, monkeypatch):
    _add_second_aria(client, "A50002")
    report, result = _classify(client, run_worker, monkeypatch, serial="A50002")

    second = _instrument_id(client, "A50002")
    assert result["serial_match"] == "matched"
    assert result["instrument_serial"]["value"] == "A50002"
    assert result["resolved_instrument_id"] == second
    assert result["suggested_instrument_id"] == second
    assert report["instrument_id"] == second
    assert report["template_id"] is not None  # resolved straight through

    first = _instrument_id(client, "A47291")
    report2, result2 = _classify(client, run_worker, monkeypatch, serial="a-47291")
    assert result2["resolved_instrument_id"] == first
    assert report2["instrument_id"] == first


def test_several_units_and_no_serial_still_needs_a_manual_pick(client, run_worker, monkeypatch):
    _add_second_aria(client)
    report, result = _classify(client, run_worker, monkeypatch, serial=None)

    assert result["serial_match"] == "not_read"
    assert result["resolved_instrument_id"] is None
    assert result["suggested_instrument_id"] is None
    assert report["instrument_id"] is None


def test_a_serial_that_is_not_in_the_fleet_falls_back_to_the_model(client, run_worker, monkeypatch):
    # One Aria: the model alone is enough, as before — but the unmatched serial is reported.
    report, result = _classify(client, run_worker, monkeypatch, serial="ZZ-0001")
    assert result["serial_match"] == "not_found"
    assert result["instrument_serial"]["value"] == "ZZ-0001"
    assert result["resolved_instrument_id"] == _instrument_id(client, "A47291")
    assert report["instrument_id"] == _instrument_id(client, "A47291")

    # Two Arias: nothing says which, so it is left for the technician.
    _add_second_aria(client)
    report2, result2 = _classify(client, run_worker, monkeypatch, serial="ZZ-0001")
    assert result2["serial_match"] == "not_found"
    assert result2["resolved_instrument_id"] is None
    assert result2["suggested_instrument_id"] is None


def test_a_serial_that_contradicts_the_model_is_not_auto_resolved(client, run_worker, monkeypatch):
    # The document's model line says Fortessa; its serial belongs to the Aria.
    report, result = _classify(client, run_worker, monkeypatch, model="LSRFortessa", serial="A47291")

    assert result["serial_match"] == "model_conflict"
    assert result["resolved_instrument_id"] is None
    assert report["instrument_id"] is None
    # ...but the unit the serial points at is offered as the starting choice.
    assert result["suggested_instrument_id"] == _instrument_id(client, "A47291")


def test_an_unsure_serial_read_is_only_a_suggestion(client, run_worker, monkeypatch):
    _add_second_aria(client)
    report, result = _classify(client, run_worker, monkeypatch, serial="A50002", serial_confidence=0.5)

    assert result["serial_match"] == "matched"
    assert result["resolved_instrument_id"] is None
    assert result["suggested_instrument_id"] == _instrument_id(client, "A50002")


def test_the_stub_picks_a_unit_by_serial_from_the_file_name_end_to_end(client, run_worker):
    _add_second_aria(client, "A50002")
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("service_A50002.pdf", b"%PDF-1.4 x", "application/pdf")},
    ).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()

    result = client.get(f"/extraction-jobs/{job['id']}").json()["classification"]
    assert result["instrument"]["value"] == "FACSAria III"
    assert result["serial_match"] == "matched"
    assert result["suggested_instrument_id"] == _instrument_id(client, "A50002")


# ---------- the live call asks for the serial ----------


def test_the_live_call_asks_for_the_serial_and_returns_it(tmp_path, monkeypatch):
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(b"%PDF-1.4 x")

    class _Messages:
        calls: list[dict] = []

        def create(self, **kwargs):
            self.calls.append(kwargs)
            return SimpleNamespace(
                content=[
                    SimpleNamespace(
                        type="tool_use",
                        input={
                            "instrument_model": "FACSDiscover S8",
                            "instrument_confidence": 0.95,
                            "report_type": "preventive_maintenance",
                            "report_type_confidence": 0.9,
                            "instrument_serial": "MP6651580000057",
                            "instrument_serial_confidence": 0.93,
                        },
                    )
                ]
            )

    client = SimpleNamespace(messages=_Messages())
    monkeypatch.setattr(classification, "_get_client", lambda: client)

    serial = classification._live_classify(None, SimpleNamespace(file_path=str(scan)), _fleet(("FACSDiscover S8", "S80019"))).serial

    assert (serial.value, serial.confidence) == ("MP6651580000057", 0.93)
    sent = client.messages.calls[0]
    schema = sent["tools"][0]["input_schema"]
    assert {"instrument_serial", "instrument_serial_confidence"} <= set(schema["required"])
    prompt = sent["messages"][0]["content"][-1]["text"]
    assert "Serial/Lot Number" in prompt and "N/A" in prompt
