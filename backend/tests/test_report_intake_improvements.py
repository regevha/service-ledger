"""Task-code report typing and duplicate detection.

* The Work Order Task Code printed on a BD service report decides the visit
  type (T113 -> repair, T111 -> PM) by a lookup in code, instead of the
  model's judgment of a generic form layout — see
  classification._apply_task_code.
* A document that is already on file is flagged, never blocked: the same file
  bytes (SHA-256, at upload) or the same work-order number (read at classify
  time) — see services/duplicates.py.
"""
from __future__ import annotations

import hashlib
from types import SimpleNamespace

import pytest

from app import models
from app.models import ReportType
from app.services import classification
from app.services.duplicates import normalize_work_order

PDF = b"%PDF-1.4 fake scan"


# ---------- unit: task code -> report type ----------


@pytest.mark.parametrize(
    ("printed", "expected"),
    [
        ("T113", ReportType.repair),
        ("t113", ReportType.repair),
        (" T113 - Repair / Troubleshooting Visit", ReportType.repair),
        ("T111", ReportType.preventive_maintenance),
        ("T111-PM", ReportType.preventive_maintenance),
        ("T999", None),  # a code we don't know the meaning of is not guessed at
        ("113", None),
        ("", None),
        (None, None),
        (113, None),
    ],
)
def test_report_type_from_task_code(printed, expected):
    assert classification.report_type_from_task_code(printed) == expected


@pytest.mark.parametrize(
    ("printed", "expected"),
    [
        ("WO-04587090", "04587090"),
        ("wo 04587090", "04587090"),
        ("04587090", "04587090"),
        (" WO04587090 ", "04587090"),
        ("N/A", None),
        ("", None),
        ("WO", None),
        ("12", None),
        (None, None),
        (4587090, None),
    ],
)
def test_normalize_work_order(printed, expected):
    assert normalize_work_order(printed) == expected


# ---------- unit: the live call applies the task code ----------


class _Messages:
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(content=[SimpleNamespace(type="tool_use", input=self.answer)])


def _live(tmp_path, monkeypatch, **overrides):
    scan = tmp_path / "scan.pdf"
    scan.write_bytes(PDF)
    answer = {
        "instrument_model": "LSRFortessa",
        "instrument_confidence": 0.95,
        "report_type": "calibration",
        "report_type_confidence": 0.55,
        **overrides,
    }
    client = SimpleNamespace(messages=_Messages(answer))
    monkeypatch.setattr(classification, "_get_client", lambda: client)
    read = classification._live_classify(None, SimpleNamespace(file_path=str(scan)), [SimpleNamespace(model="LSRFortessa")])
    return read, client


def test_a_confidently_read_task_code_decides_the_report_type(tmp_path, monkeypatch):
    read, _ = _live(tmp_path, monkeypatch, task_code="T113", task_code_confidence=0.96)
    assert (read.report_type.value, read.report_type.confidence) == ("repair", 0.96)
    assert read.report_type_source == "task_code"


def test_the_task_code_beats_a_confident_but_disagreeing_model(tmp_path, monkeypatch):
    read, _ = _live(
        tmp_path, monkeypatch, report_type="repair", report_type_confidence=0.99, task_code="T111", task_code_confidence=0.9
    )
    assert read.report_type.value == "preventive_maintenance"
    assert read.report_type_source == "task_code"


def test_agreement_keeps_the_higher_of_the_two_confidences(tmp_path, monkeypatch):
    read, _ = _live(
        tmp_path, monkeypatch, report_type="repair", report_type_confidence=0.98, task_code="T113", task_code_confidence=0.9
    )
    assert (read.report_type.value, read.report_type.confidence) == ("repair", 0.98)


@pytest.mark.parametrize(
    "fields",
    [
        {"task_code": "T113", "task_code_confidence": 0.4},  # read with doubt: ignored
        {"task_code": "T113", "task_code_confidence": "high"},  # malformed confidence: ignored
        {"task_code": "T113"},  # no confidence at all: ignored
        {"task_code": "T999", "task_code_confidence": 0.99},  # unknown code: not guessed at
        {"task_code": "", "task_code_confidence": 0},
        {},  # an older-style answer with no task-code fields still classifies
    ],
)
def test_without_a_usable_task_code_the_models_guess_stands(tmp_path, monkeypatch, fields):
    read, _ = _live(tmp_path, monkeypatch, **fields)
    assert (read.report_type.value, read.report_type.confidence) == ("calibration", 0.55)
    assert read.report_type_source == "model"


def test_the_live_call_asks_for_the_task_code_and_work_order(tmp_path, monkeypatch):
    read, client = _live(tmp_path, monkeypatch, work_order_number=" WO-04587090 ")
    sent = client.messages.calls[0]
    assert {"task_code", "task_code_confidence", "work_order_number"} <= set(sent["tools"][0]["input_schema"]["required"])
    assert "task_code" in sent["messages"][0]["content"][-1]["text"]
    assert read.work_order_number == "WO-04587090"


@pytest.mark.parametrize("answered", ["", "   ", None, 7])
def test_no_work_order_read_is_none(tmp_path, monkeypatch, answered):
    read, _ = _live(tmp_path, monkeypatch, work_order_number=answered)
    assert read.work_order_number is None


# ---------- integration: duplicates are flagged, never blocked ----------


def _new_report(client) -> str:
    return client.post("/reports", json={"technician_name": "R. Tester"}).json()["id"]


def _upload(client, report_id: str, name: str, data: bytes = PDF):
    resp = client.post(f"/reports/{report_id}/attachments", files={"file": (name, data, "application/pdf")})
    assert resp.status_code == 201
    return resp.json()


def _classify(client, run_worker, attachment_id: str) -> dict:
    job = client.post(f"/attachments/{attachment_id}/classify").json()
    run_worker()
    done = client.get(f"/extraction-jobs/{job['id']}").json()
    assert done["status"] == "succeeded"
    return done["classification"]


def test_upload_stores_the_content_hash(client, db_session):
    attachment = _upload(client, _new_report(client), "a.pdf")
    row = db_session.get(models.Attachment, attachment["id"])
    assert row.content_sha256 == hashlib.sha256(PDF).hexdigest()


def test_the_same_bytes_under_another_report_are_flagged_but_still_stored(client):
    first_report, second_report = _new_report(client), _new_report(client)
    first = _upload(client, first_report, "scan.pdf")
    assert first["duplicate_report_ids"] == []

    second = _upload(client, second_report, "scan (copy).pdf")
    assert second["duplicate_report_ids"] == [first_report]
    # Flagged, not refused: the second file is stored and usable.
    assert client.get(f"/attachments/{second['id']}/file").status_code == 200


def test_different_bytes_and_re_attaching_to_the_same_report_are_not_flagged(client):
    report = _new_report(client)
    _upload(client, report, "a.pdf")
    assert _upload(client, report, "a-again.pdf")["duplicate_report_ids"] == []
    assert _upload(client, _new_report(client), "b.pdf", PDF + b" different")["duplicate_report_ids"] == []


def test_the_same_work_order_in_a_different_file_is_flagged_at_classify(client, run_worker, db_session):
    first_report, second_report = _new_report(client), _new_report(client)
    first = _upload(client, first_report, "visit_WO-04587090.pdf")
    first_result = _classify(client, run_worker, first["id"])
    assert first_result["work_order_number"] == "WO-04587090"
    assert first_result["duplicate_report_ids"] == []
    assert db_session.get(models.Attachment, first["id"]).work_order_number == "04587090"

    # A re-scan: different bytes, different file name, same work order.
    rescan = _upload(client, second_report, "rescan wo04587090.pdf", PDF + b" rescanned")
    assert rescan["duplicate_report_ids"] == []  # bytes differ — only classify can tell
    result = _classify(client, run_worker, rescan["id"])
    assert result["duplicate_report_ids"] == [first_report]
    # A warning, not a block: classification still resolved the report.
    assert result["resolved_template_id"] is not None and result["resolved_instrument_id"] is not None


def test_a_document_with_no_work_order_is_never_a_work_order_duplicate(client, run_worker, db_session):
    first = _upload(client, _new_report(client), "plain_a.pdf")
    second = _upload(client, _new_report(client), "plain_b.pdf", PDF + b" other")
    _classify(client, run_worker, first["id"])
    result = _classify(client, run_worker, second["id"])
    assert result["work_order_number"] is None and result["duplicate_report_ids"] == []
    assert db_session.get(models.Attachment, second["id"]).work_order_number is None


def test_reclassifying_the_same_attachment_does_not_flag_itself(client, run_worker):
    attachment = _upload(client, _new_report(client), "visit_WO-04587090.pdf")
    _classify(client, run_worker, attachment["id"])
    assert _classify(client, run_worker, attachment["id"])["duplicate_report_ids"] == []
