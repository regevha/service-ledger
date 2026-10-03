"""Regression tests for correctness bugs found in code review and fixed
after the rest of this suite was written. None of these was caught by an
existing test; each test here fails against the code as it was before its
fix. Grouped by the area of the app the bug lived in.
"""
from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta, timezone

import pytest
from pypdf import PdfReader
from sqlalchemy.exc import IntegrityError

from app import models, seed_templates
from app.schemas import ClassificationGuess
from app.services import claude_client
from app.services.analytics import compute_fleet_analytics
from app.services.classification import classify
from tests.conftest import TestSessionLocal

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


# ---------- helpers ----------


def _confident(monkeypatch, model: str = "LSRFortessa", report_type: str = "repair"):
    """Pin the stub classifier to a confident guess, so a test can rely on
    classify resolving straight through to a known template."""
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: (
            ClassificationGuess(value=model, confidence=0.99),
            ClassificationGuess(value=report_type, confidence=0.99),
            None,
        ),
    )


def _extracted_report(client, run_worker, monkeypatch):
    """A report taken through upload → confident classify → extract."""
    _confident(monkeypatch)
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    report = client.get(f"/reports/{report['id']}").json()
    assert report["status"] == "extracted"
    return report, attachment


def _finalized_report(client, run_worker, monkeypatch):
    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    assert client.post(f"/reports/{report['id']}/finalize").status_code == 200
    return client.get(f"/reports/{report['id']}").json(), attachment


def _template(db, report_type: models.ReportType, model: str | None = None) -> models.ReportTemplate:
    return (
        db.query(models.ReportTemplate)
        .filter(models.ReportTemplate.report_type == report_type, models.ReportTemplate.model == model)
        .one()
    )


# ---------- finalized reports can't be changed by classify/extract/confirm ----------


def test_classify_and_extract_reject_a_finalized_report(client, run_worker, monkeypatch):
    report, attachment = _finalized_report(client, run_worker, monkeypatch)

    assert client.post(f"/attachments/{attachment['id']}/classify").status_code == 409
    assert client.post(f"/attachments/{attachment['id']}/extract").status_code == 409

    after = client.get(f"/reports/{report['id']}").json()
    assert after["status"] == "finalized"
    assert after["extracted_fields"] == report["extracted_fields"]


def test_confirm_template_rejects_a_finalized_report(client, run_worker, monkeypatch):
    report, _ = _finalized_report(client, run_worker, monkeypatch)
    resp = client.patch(
        f"/reports/{report['id']}/template",
        json={"instrument_id": report["instrument_id"], "template_id": report["template_id"]},
    )
    assert resp.status_code == 409
    assert client.get(f"/reports/{report['id']}").json()["status"] == "finalized"


def test_report_finalized_while_extraction_runs_is_not_overwritten(client, run_worker, monkeypatch):
    """The worker's finalized check used to run only *before* the slow
    extract call, so a report finalized while Claude was working was still
    overwritten — status reverted to "extracted" with finalized_at still
    set, and the technician's corrections lost."""
    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    client.patch(f"/reports/{report['id']}/fields", json={"extracted_fields": {"labor_hours": 7}})
    job = client.post(f"/attachments/{attachment['id']}/extract").json()

    from app.worker import run_extract as real_run_extract

    def _extract_while_technician_finalizes(att, template):
        result = real_run_extract(att, template)
        # The technician finalizes in another request while extraction runs.
        assert client.post(f"/reports/{report['id']}/finalize").status_code == 200
        return result

    monkeypatch.setattr("app.worker.run_extract", _extract_while_technician_finalizes)
    run_worker()

    after = client.get(f"/reports/{report['id']}").json()
    assert after["status"] == "finalized"
    assert after["finalized_at"] is not None
    assert after["extracted_fields"]["labor_hours"] == 7
    assert client.get(f"/extraction-jobs/{job['id']}").json()["status"] == "failed"


def test_template_changed_while_extraction_runs_discards_the_result(client, run_worker, monkeypatch, seeded):
    report, attachment = _extracted_report(client, run_worker, monkeypatch)
    other = next(t for t in client.get("/report-templates/all").json() if t["id"] != report["template_id"])
    job = client.post(f"/attachments/{attachment['id']}/extract").json()

    from app.worker import run_extract as real_run_extract

    def _extract_while_template_changes(att, template):
        result = real_run_extract(att, template)
        client.patch(
            f"/reports/{report['id']}/template",
            json={"instrument_id": report["instrument_id"], "template_id": other["id"]},
        )
        return result

    monkeypatch.setattr("app.worker.run_extract", _extract_while_template_changes)
    run_worker()

    after = client.get(f"/reports/{report['id']}").json()
    assert after["template_id"] == other["id"]
    assert after["extracted_fields"] == {}  # cleared by the template change, not refilled with the old schema's keys
    assert client.get(f"/extraction-jobs/{job['id']}").json()["status"] == "failed"


def test_reclassifying_onto_a_different_template_clears_old_fields(client, run_worker, monkeypatch):
    """confirm_template clears extracted_fields when the template changes;
    the worker's auto-resolve path didn't, leaving the old template's keys
    on a report now pointing at a new template."""
    report, attachment = _extracted_report(client, run_worker, monkeypatch)  # resolves repair/(any model)
    pm = next(t for t in client.get("/report-templates/all").json() if t["report_type"] == "preventive_maintenance")
    client.patch(
        f"/reports/{report['id']}/template",
        json={"instrument_id": report["instrument_id"], "template_id": pm["id"]},
    )
    client.patch(f"/reports/{report['id']}/fields", json={"extracted_fields": {"verification_result": "pass"}})

    client.post(f"/attachments/{attachment['id']}/classify")  # stub still says repair
    run_worker()

    after = client.get(f"/reports/{report['id']}").json()
    assert after["template_id"] == report["template_id"]  # back on the repair template
    assert after["extracted_fields"] == {}


# ---------- classification ----------


def test_confident_guess_is_not_auto_resolved_when_two_instruments_share_the_model(client, seeded, monkeypatch):
    _confident(monkeypatch, model="LSRFortessa")
    db = seeded
    report = models.Report()
    db.add(report)
    db.flush()
    attachment = models.Attachment(report_id=report.id, file_path="x.pdf", file_type="application/pdf", page_count=1)
    db.add(attachment)
    db.commit()

    assert classify(db, attachment).resolved_instrument_id is not None  # one LSRFortessa: resolves

    resp = client.post(
        "/instruments", json={"name": "Second Fortessa", "model": "LSRFortessa", "serial_number": "DUP-0002"}
    )
    assert resp.status_code == 201
    db.expire_all()
    result = classify(db, attachment)
    assert result.resolved_instrument_id is None
    assert result.resolved_template_id is None


def test_stable_unit_stays_below_one_for_an_all_f_digest(monkeypatch):
    class _AllF:
        def hexdigest(self):
            return "f" * 64

    monkeypatch.setattr(claude_client.hashlib, "sha256", lambda data: _AllF())
    assert 0 <= claude_client.stable_unit("anything") < 1


# ---------- report templates ----------


def test_patch_template_with_null_report_type_is_a_clean_422(client):
    tpl = client.get("/report-templates/all").json()[0]
    resp = client.patch(f"/report-templates/{tpl['id']}", json={"report_type": None})
    assert resp.status_code == 422
    assert client.get(f"/report-templates/{tpl['id']}").json()["report_type"] == tpl["report_type"]


def test_deleting_a_referenced_template_is_refused_by_the_database_not_nulled(seeded):
    """With the ORM's default delete handling, deleting a template silently
    nulled every referencing report's template_id first — which is how
    DELETE /report-templates/{id} could lose a race with PATCH .../template
    and return 204 with the report's link wiped. The DB's RESTRICT must be
    what decides."""
    db = seeded
    template = _template(db, models.ReportType.repair)
    report = models.Report(template_id=template.id)
    db.add(report)
    db.commit()

    db.delete(template)
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()

    with TestSessionLocal() as fresh:
        assert fresh.get(models.Report, report.id).template_id == template.id


def test_seed_templates_skips_a_stale_row_that_a_report_still_uses(seeded, capsys):
    db = seeded
    stale = models.ReportTemplate(
        instrument_type="facs",
        report_type=models.ReportType.preventive_maintenance,
        model="LeftoverModel",
        field_schema={"fields": [{"name": "f", "type": "text", "unit": None, "notes": None}]},
    )
    db.add(stale)
    db.commit()
    db.add(models.Report(template_id=stale.id, status=models.ReportStatus.finalized))
    db.commit()

    seed_templates.seed(db)  # used to crash with IntegrityError

    assert db.get(models.ReportTemplate, stale.id) is not None
    assert "LeftoverModel" in capsys.readouterr().out


# ---------- analytics, PDF, ordering ----------


def test_times_replaced_counts_reports_not_rows(seeded):
    db = seeded
    template = _template(db, models.ReportType.repair)
    db.add(
        models.Report(
            template_id=template.id,
            status=models.ReportStatus.finalized,
            extracted_fields={
                "components_replaced": [
                    {"part_name": "O-ring", "part_number": "OR-1", "qty": 1},
                    {"part_name": "O-ring", "part_number": "OR-1", "qty": 1},
                ]
            },
        )
    )
    db.commit()

    part = next(p for p in compute_fleet_analytics(db).parts_replaced if p.part_name == "O-ring")
    assert part.times_replaced == 1
    assert part.total_qty == 2


def test_pdf_tolerates_non_dict_rows_and_prints_booleans_as_yes_no(client, seeded):
    db = seeded
    template = models.ReportTemplate(
        instrument_type="facs",
        report_type=models.ReportType.repair,
        model="PdfTestModel",
        field_schema={
            "fields": [
                {
                    "name": "checks",
                    "type": "object[]",
                    "unit": None,
                    "notes": None,
                    "item_schema": [{"name": "step", "type": "text"}, {"name": "passed", "type": "boolean"}],
                }
            ]
        },
    )
    db.add(template)
    db.commit()
    report = models.Report(
        template_id=template.id,
        status=models.ReportStatus.in_review,
        extracted_fields={"checks": ["not a row", {"step": "Laser alignment", "passed": False}]},
    )
    db.add(report)
    db.commit()

    resp = client.get(f"/reports/{report.id}/pdf")
    assert resp.status_code == 200
    text = "\n".join(page.extract_text() for page in PdfReader(io.BytesIO(resp.content)).pages)
    assert "Laser alignment" in text
    assert "No" in text
    assert "False" not in text


def test_export_orders_undated_reports_by_creation_time(client, seeded):
    db = seeded
    template = _template(db, models.ReportType.repair)
    now = datetime.now(timezone.utc)
    for name, age in (("newest", 0), ("oldest", 2), ("middle", 1)):
        db.add(
            models.Report(
                template_id=template.id,
                technician_name=name,
                report_date=None,
                created_at=now - timedelta(days=age),
            )
        )
    db.commit()

    rows = list(csv.DictReader(io.StringIO(client.get("/reports/export").text)))
    assert [r["technician_name"] for r in rows] == ["oldest", "middle", "newest"]


# --- Stub: real BD files are not the built-in sample --------------------------


def test_stub_sample_detection_uses_the_uploaded_file_name_only():
    from app.services.claude_client import is_sample_document

    # The spec's sample work order, by number or by the dedicated fixture's name.
    assert is_sample_document("storage/attachments/ab12/cd34_WO-04587090_sample.pdf")
    assert is_sample_document("storage/attachments/ab12/cd34_sample-work-order.pdf")
    # A real BD file is *titled* "Work Order Service Report" — that must not be
    # enough, or a FACSDiscover S8 PM gets the LSRFortessa repair data.
    real = "storage/attachments/ab12/cd34_BD_EU_Work_Order_Service_Report_Label_v3_S8_10-2-26.pdf"
    assert not is_sample_document(real)
    assert not is_sample_document("storage/attachments/ab12/cd34_work-order.pdf")
    # Nothing outside the file's own name counts.
    assert not is_sample_document("storage/sample/attachments/ab12/cd34_scan.pdf")


def test_stub_does_not_answer_a_real_work_order_report_with_the_sample_data(client, run_worker, monkeypatch):
    from app.services import classification

    # The stub's guess for a non-sample file is hash-seeded from the stored
    # path (which has a random uuid in it), so asserting on the guessed values
    # would be a coin flip; record what the sample check decided instead.
    decisions = []
    real_check = classification._is_sample_document
    monkeypatch.setattr(
        classification, "_is_sample_document", lambda path: decisions.append(real_check(path)) or decisions[-1]
    )

    name = "BD_EU_Work_Order_Service_Report_Label_v3_S8_10-2-26.pdf"
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": (name, b"%PDF-1.4 real report", "application/pdf")},
    ).json()
    job = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()

    assert client.get(f"/extraction-jobs/{job['id']}").json()["status"] == "succeeded"
    assert decisions == [False]
