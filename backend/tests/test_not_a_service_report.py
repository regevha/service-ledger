"""A file that is not a service report is flagged `recognized: false`, not offered as a new instrument.

Before: a photo or blank page read as "model not clear, report type not clear, no serial"
and the intake screen asked the person to add an instrument for it. The classification
result now says `recognized: false` when nothing on the file ties it to a service visit
(or the reader says it is not a service document); a real report from an unknown model
(a maker, a model or a serial was read) stays recognized so it can still be added.
"""
from __future__ import annotations

from app.schemas import ClassificationGuess
from app.services import classification
from app.services.classification_reading import DocumentRead, nothing_read


def _threshold() -> float:
    return classification.settings.classification_confidence_threshold


def _guess(value: str, confidence: float) -> ClassificationGuess:
    return ClassificationGuess(value=value, confidence=confidence)


def _read(**kw) -> DocumentRead:
    base = dict(
        instrument=_guess("FACSAria III", 0.0),
        report_type=_guess("repair", 0.0),
        serial=None,
    )
    base.update(kw)
    return DocumentRead(**base)


def test_nothing_read_when_every_field_is_empty():
    assert nothing_read(_read(), _threshold())


def test_nothing_read_when_the_reader_says_not_a_service_document():
    assert nothing_read(_read(instrument=_guess("FACSAria III", 0.99), is_service_document=False), _threshold())


def test_a_serial_a_maker_a_model_or_a_work_order_keeps_it_recognized():
    t = _threshold()
    assert not nothing_read(_read(serial=_guess("X123", 0.5)), t)
    assert not nothing_read(_read(detected_manufacturer="Acme", maker_in_fleet=False), t)
    assert not nothing_read(_read(detected_model="Acme One", maker_in_fleet=False), t)
    assert not nothing_read(_read(work_order_number="WO-90000001"), t)
    assert not nothing_read(_read(issuer="Some Distributor"), t)


def test_a_confident_report_type_or_instrument_keeps_it_recognized():
    t = _threshold()
    assert not nothing_read(_read(report_type=_guess("repair", t)), t)
    assert not nothing_read(_read(instrument=_guess("FACSAria III", t)), t)


def test_stub_marker_file_is_not_recognized_and_nothing_else_is(client, run_worker):
    def classify_file(name: str) -> dict:
        report = client.post("/reports", json={}).json()
        attachment = client.post(
            f"/reports/{report['id']}/attachments",
            files={"file": (name, b"%PDF-1.4 " + name.encode(), "application/pdf")},
        ).json()
        job = client.post(f"/attachments/{attachment['id']}/classify").json()
        run_worker()
        return client.get(f"/extraction-jobs/{job['id']}").json()["classification"]

    rejected = classify_file("notareport-photo.pdf")
    assert rejected["recognized"] is False
    assert rejected["resolved_template_id"] is None

    ordinary = classify_file("scan.pdf")
    assert ordinary["recognized"] is True
