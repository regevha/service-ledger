"""Near-miss copies of the instrument's serial in extracted text are replaced
with the real serial (services/serial_check.py). Born from the FACSDiscover S8
software upgrade report: its Subject line says "S/N R6651580000057" while the
instrument is MP6651580000057, and the wrong serial was stored on every live run
(2026-10-10, 10-15, 10-19)."""
from __future__ import annotations

import pytest

from app.services.serial_check import correct_serial_typos

S8 = "MP6651580000057"


def test_the_s8_subject_line_is_corrected():
    fields = {"service_description": "Software upgrade from 6.2 to 6.3 - S8 S/N R6651580000057"}
    fixes = correct_serial_typos(fields, S8)
    assert fields["service_description"] == f"Software upgrade from 6.2 to 6.3 - S8 S/N {S8}"
    assert [(f.field, f.found) for f in fixes] == [("service_description", "R6651580000057")]


def test_the_correct_serial_is_left_alone_in_any_case_or_punctuation():
    fields = {"a": f"S/N {S8}", "b": "mp-6651580000057", "c": "MP 6651580000057"}
    assert correct_serial_typos(fields, S8) == []
    assert fields["a"] == f"S/N {S8}"
    assert fields["b"] == "mp-6651580000057"


@pytest.mark.parametrize(
    "text",
    [
        "Work order WO-04482628 closed",  # unrelated identifier
        "Contract SMX0457374",  # contract number
        "Part 644651 replaced",  # short number
        "Tool T-4240-003-01 checked",  # part-like
        "Serial MP6651580000999 on the other unit",  # three digits away: a different machine
        "Software 6.2 to 6.3",
    ],
)
def test_other_identifiers_are_never_touched(text):
    fields = {"work_performed": text}
    assert correct_serial_typos(fields, S8) == []
    assert fields["work_performed"] == text


def test_only_text_values_are_changed():
    fields = {
        "labor_hours": 8,
        "parts_used": [{"part": "R6651580000057"}],
        "signed": True,
        "note": None,
        "service_description": "S/N R6651580000057",
    }
    correct_serial_typos(fields, S8)
    assert fields["parts_used"] == [{"part": "R6651580000057"}]
    assert fields["labor_hours"] == 8
    assert fields["service_description"] == f"S/N {S8}"


def test_every_occurrence_in_every_field_is_fixed_and_reported():
    fields = {"a": "R6651580000057 and again R6651580000057", "b": "MP6651580000058"}
    fixes = correct_serial_typos(fields, S8)
    assert fields["a"] == f"{S8} and again {S8}"
    assert fields["b"] == S8
    assert len(fixes) == 3


def test_distance_allowed_depends_on_serial_length():
    # Twelve characters: two edits allowed.
    fields = {"t": "R647794E6099 and P647794E6092"}
    correct_serial_typos(fields, "R647794E6092")
    assert fields["t"] == "R647794E6092 and P647794E6092".replace("P647794E6092", "R647794E6092")
    # Eight or nine characters: one edit only.
    fields = {"t": "AB123456 AB123499"}
    correct_serial_typos(fields, "AB123457")
    assert fields["t"] == "AB123457 AB123499"


@pytest.mark.parametrize(
    "short, text",
    [("Y1033", "Y10334 Y1033XX"), ("102579", "1025790X 1025798"), ("AB12345", "AB123456 XAB12345")],
)
def test_short_serials_are_never_matched_loosely(short, text):
    """Under eight characters a near-miss is too likely to be a different
    number, so nothing is replaced (the words here are long enough to be looked
    at, one edit from the serial)."""
    fields = {"t": text}
    assert correct_serial_typos(fields, short) == []
    assert fields["t"] == text


def test_a_word_without_digits_is_never_replaced():
    # One edit from a nine-character serial, but it is an ordinary word.
    fields = {"t": "ABCDEFGHI"}
    assert correct_serial_typos(fields, "ABCDEFGH1") == []
    assert fields["t"] == "ABCDEFGHI"


def test_a_correct_part_of_the_serial_is_not_a_typo():
    # "MP 6651580000057": the number half alone is two edits from the serial,
    # and replacing it would give "MP MP6651580000057".
    fields = {"t": "S/N MP 6651580000057"}
    assert correct_serial_typos(fields, S8) == []
    assert fields["t"] == "S/N MP 6651580000057"


# ---------- through the worker ----------


def test_the_worker_stores_the_corrected_text_and_logs_it(client, run_worker, monkeypatch, caplog, seeded):
    from app.schemas import ClassificationGuess
    from app.services.extraction import ExtractionResult

    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: (
            ClassificationGuess(value="LSRFortessa", confidence=0.99),
            ClassificationGuess(value="repair", confidence=0.99),
            None,
        ),
    )
    report = client.post("/reports", json={}).json()
    pdf = ("scan.pdf", b"%PDF-1.4 serial-fix", "application/pdf")
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": pdf}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    instrument_id = client.get(f"/reports/{report['id']}").json()["instrument_id"]
    instrument = client.get(f"/instruments/{instrument_id}").json()
    serial = instrument["serial_number"]
    wrong = serial[:-1] + ("0" if serial[-1] != "0" else "1")

    def _fake(att, template):
        return ExtractionResult({"work_performed": f"Checked unit S/N {wrong} and tested", "labor_hours": 2}, {}, None)

    monkeypatch.setattr("app.worker.run_extract", _fake)
    client.post(f"/attachments/{attachment['id']}/extract")
    with caplog.at_level("WARNING", logger="app.worker"):
        run_worker()

    stored = client.get(f"/reports/{report['id']}").json()["extracted_fields"]
    assert stored["work_performed"] == f"Checked unit S/N {serial} and tested"
    assert stored["labor_hours"] == 2
    assert any(wrong in r.getMessage() for r in caplog.records)


def test_the_extraction_prompt_tells_the_model_not_to_copy_serials():
    from app.services.extraction import _EXTRACT_PROMPT_HEADER

    assert "do not copy a serial number" in _EXTRACT_PROMPT_HEADER
