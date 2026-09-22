"""Tests for GET /reports/{id}/pdf — the single-report PDF export (§7/§11).

Exercises the endpoint through the real HTTP layer (404/409 preconditions,
content-type/disposition headers) and checks the actual rendered PDF text
via pypdf rather than just asserting the byte string is non-empty — a
crash-free PDF that's silently missing every field value would still pass a
"bytes exist" test, so this extracts real text and looks for it.

Report rows are built directly through the ORM, same rationale as
test_reports_search_export.py: the stub classifier's template/instrument
pick isn't something a test can dial to a specific combination, and PDF
rendering only reads already-resolved rows, so hand-built fixtures exercise
the same code path as a real report would.
"""
from __future__ import annotations

import io
from datetime import date

from pypdf import PdfReader

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def _make_report(
    db_session,
    *,
    model: str,
    report_type: ReportType,
    status: ReportStatus,
    technician: str,
    extracted_fields: dict | None = None,
    report_date: date | None = None,
    finalized: bool = False,
):
    instrument = db_session.query(Instrument).filter(Instrument.model == model).one()
    template = (
        db_session.query(ReportTemplate)
        .filter(ReportTemplate.report_type == report_type)
        .filter((ReportTemplate.model == model) | (ReportTemplate.model.is_(None)))
        .first()
    )
    assert template is not None, f"No seeded template for {report_type}/{model}"
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields=extracted_fields if extracted_fields is not None else {},
        technician_name=technician,
        report_date=report_date,
        finalized_at=None,
    )
    db_session.add(report)
    db_session.commit()
    db_session.refresh(report)
    return report


def _pdf_text(content: bytes) -> str:
    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def test_pdf_404_for_missing_report(client):
    resp = client.get("/reports/00000000-0000-0000-0000-000000000000/pdf")
    assert resp.status_code == 404


def test_pdf_409_when_report_has_no_resolved_template(client):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    resp = client.get(f"/reports/{report['id']}/pdf")
    assert resp.status_code == 409


def test_pdf_renders_repair_report_fields(client, seeded):
    """Covers text, number, enum, and object[] (a real table) — repair's
    field list (seed_templates.py) exercises all four in one template."""
    report = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        status=ReportStatus.finalized,
        technician="R. Tester",
        report_date=date(2026, 3, 1),
        extracted_fields={
            "fault_description": "Sample not aspirating consistently",
            "root_cause": "Worn sheath filter",
            "work_performed": "Replaced sheath filter,\nran fluidics diagnostic",
            "components_replaced": [
                {"part_name": "Sheath filter", "part_number": "SF-100", "qty": 1},
            ],
            "labor_hours": 2.5,
            "fault_category": "fluidics",
            "retest_result": "pass",
        },
    )

    resp = client.get(f"/reports/{report.id}/pdf")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"
    assert f"attachment; filename=report_{report.id}.pdf" in resp.headers["content-disposition"]
    assert resp.content[:5] == b"%PDF-"

    text = _pdf_text(resp.content)
    assert "LSRFortessa" in text
    assert "R. Tester" in text
    assert "Malfunction / repair" in text
    assert "Sample not aspirating consistently" in text
    assert "Worn sheath filter" in text
    assert "2.5 hours" in text
    assert "fluidics" in text
    # object[] renders as a table — its item_schema column headers and the
    # row's actual values should both appear.
    assert "Sheath filter" in text
    assert "SF-100" in text


def test_pdf_renders_calibration_fields_including_missing_values(client, seeded):
    """Covers enum[], number[detector] (a per-detector map), boolean, and a
    field left unset entirely (should print the em dash placeholder, not
    crash or silently vanish)."""
    report = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.calibration,
        status=ReportStatus.in_review,
        technician="A. Tech",
        extracted_fields={
            "laser_configuration": ["405nm", "488nm", "640nm"],
            "baseline_cv_percent": {"FITC": 2.1, "PE": 1.8},
            "compensation_matrix_updated": True,
            # fluidics_pressure_psi and cst_beads_lot deliberately omitted —
            # the review screen leaves unextracted fields blank rather than
            # dropping them from the form, and the PDF should do the same.
        },
    )

    resp = client.get(f"/reports/{report.id}/pdf")
    assert resp.status_code == 200
    text = _pdf_text(resp.content)
    assert "405nm" in text
    assert "488nm" in text
    assert "FITC: 2.1" in text
    assert "PE: 1.8" in text
    assert "Yes" in text  # compensation_matrix_updated: True -> "Yes"
    assert "—" in text  # the omitted fields render as the missing-value placeholder


def test_pdf_available_before_finalization(client, seeded):
    """Not gated on status=finalized — a technician mid-review should still
    be able to pull a PDF snapshot, same as the review screen itself has no
    such restriction."""
    report = _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.calibration,
        status=ReportStatus.extracted,
        technician="A. Tech",
        extracted_fields={},
    )
    resp = client.get(f"/reports/{report.id}/pdf")
    assert resp.status_code == 200
    assert resp.content[:5] == b"%PDF-"
