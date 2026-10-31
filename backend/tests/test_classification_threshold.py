"""The classification confidence threshold, exactly at its boundary.

A mutation check on 2026-10-17 changed `>=` to `>` and `<` to `<=` in these
comparisons and no test failed: every existing test used values well away from
the threshold. These pin the rule at the edge: a read at exactly the threshold
counts as confident; anything below it does not.

Where the threshold is used (services/classification.py):
- the model and report-type guesses must each be at or above it to resolve a
  template automatically;
- a serial read must be at or above it to pick one unit among several;
- a task code read below it is ignored in favour of the model's own guess.
"""
from __future__ import annotations

import pytest

from app.schemas import ClassificationGuess
from app.services import classification
from app.services.classification import _apply_task_code

PDF = ("scan.pdf", b"%PDF-1.4 threshold", "application/pdf")


def _threshold() -> float:
    return classification.settings.classification_confidence_threshold


def _below() -> float:
    return round(_threshold() - 0.01, 2)


def _above() -> float:
    return round(_threshold() + 0.01, 2)


def _guess(value, confidence):
    return ClassificationGuess(value=value, confidence=confidence)


def _classify(client, run_worker, monkeypatch, *, model_conf=0.99, type_conf=0.99, serial=None, serial_conf=0.99):
    monkeypatch.setattr(
        classification,
        "_stub_classify",
        lambda attachment, instruments: (
            _guess("FACSAria III", model_conf),
            _guess("preventive_maintenance", type_conf),
            _guess(serial, serial_conf) if serial is not None else None,
        ),
    )
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()
    return client.get(f"/extraction-jobs/{job['id']}").json()["classification"]


def _add_second_aria(client, serial="A50002"):
    resp = client.post(
        "/instruments",
        json={"name": "Aria Annex", "model": "FACSAria III", "manufacturer": "TestCo", "serial_number": serial},
    )
    assert resp.status_code == 201


# ---------- the instrument-model guess ----------


@pytest.mark.parametrize("confidence, resolves", [("below", False), ("at", True), ("above", True)])
def test_instrument_guess_resolves_only_at_or_above_the_threshold(client, run_worker, monkeypatch, confidence, resolves):
    value = {"below": _below(), "at": _threshold(), "above": _above()}[confidence]
    result = _classify(client, run_worker, monkeypatch, model_conf=value)
    assert (result["resolved_template_id"] is not None) is resolves
    assert (result["resolved_instrument_id"] is not None) is resolves


# ---------- the report-type guess ----------


@pytest.mark.parametrize("confidence, resolves", [("below", False), ("at", True), ("above", True)])
def test_report_type_guess_resolves_only_at_or_above_the_threshold(client, run_worker, monkeypatch, confidence, resolves):
    value = {"below": _below(), "at": _threshold(), "above": _above()}[confidence]
    result = _classify(client, run_worker, monkeypatch, type_conf=value)
    assert (result["resolved_template_id"] is not None) is resolves
    assert (result["resolved_instrument_id"] is not None) is resolves


# ---------- the serial read, choosing one unit among several ----------


@pytest.mark.parametrize("confidence, picks_the_unit", [("below", False), ("at", True), ("above", True)])
def test_serial_read_picks_a_unit_only_at_or_above_the_threshold(
    client, run_worker, monkeypatch, confidence, picks_the_unit
):
    _add_second_aria(client, "A50002")
    value = {"below": _below(), "at": _threshold(), "above": _above()}[confidence]
    result = _classify(client, run_worker, monkeypatch, serial="A50002", serial_conf=value)

    assert result["serial_match"] == "matched"  # the match itself does not depend on confidence
    if picks_the_unit:
        assert result["resolved_instrument_id"] is not None
    else:
        # Two Aria units and a doubtful serial: the technician picks.
        assert result["resolved_instrument_id"] is None
        assert result["resolved_template_id"] is None


# ---------- the task code ----------


@pytest.mark.parametrize("confidence, trusted", [("below", False), ("at", True), ("above", True)])
def test_task_code_is_trusted_only_at_or_above_the_threshold(confidence, trusted):
    value = {"below": _below(), "at": _threshold(), "above": _above()}[confidence]
    model_guess = _guess("preventive_maintenance", 0.5)
    guess, source = _apply_task_code(model_guess, {"task_code": "T113", "task_code_confidence": value}, "x.pdf", "BD")
    if trusted:
        assert source == "task_code"
        assert guess.value == "repair"
    else:
        assert source == "model"
        assert guess == model_guess


def test_the_boundary_tests_follow_the_configured_threshold(monkeypatch):
    # They read the live setting, so changing it moves the edge with it.
    monkeypatch.setattr(classification.settings, "classification_confidence_threshold", 0.6)
    model_guess = _guess("preventive_maintenance", 0.1)
    assert _apply_task_code(model_guess, {"task_code": "T113", "task_code_confidence": 0.6}, "x.pdf", "BD")[1] == "task_code"
    assert _apply_task_code(model_guess, {"task_code": "T113", "task_code_confidence": 0.59}, "x.pdf", "BD")[1] == "model"
