"""Coverage for app/routers/instruments.py — POST /instruments and the
GET /instruments/{id}/trend series endpoint had no tests at all before this
file (0/17 and 0/? relevant statements, per `pytest --cov`), despite
`instrument_trend` being real filtering/aggregation logic (only finalized
reports, only numeric values for the requested key) that backs
instrument-timeline-demo.html.
"""
from __future__ import annotations

import uuid
from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def test_create_instrument(client):
    resp = client.post(
        "/instruments",
        json={"name": "Test Cytometer", "model": "TestModel-9000", "serial_number": "TC-0001", "location": "Bench 9"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["model"] == "TestModel-9000"
    assert body["serial_number"] == "TC-0001"
    assert body["status"] == "active"


def test_create_instrument_conflicts_on_duplicate_serial(client):
    payload = {"name": "Dup", "model": "TestModel-9000", "serial_number": "TC-0002"}
    first = client.post("/instruments", json=payload)
    assert first.status_code == 201
    second = client.post("/instruments", json=payload)
    assert second.status_code == 409


def test_instrument_trend_404_on_missing_instrument(client):
    resp = client.get(f"/instruments/{uuid.uuid4()}/trend", params={"field": "labor_hours"})
    assert resp.status_code == 404


def test_instrument_trend_only_counts_finalized_reports_with_numeric_values(client, seeded):
    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    template = seeded.query(ReportTemplate).filter(ReportTemplate.report_type == ReportType.repair).first()

    def make(status, report_date, extracted_fields):
        report = Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=status,
            extracted_fields=extracted_fields,
            report_date=report_date,
        )
        seeded.add(report)
        seeded.commit()
        seeded.refresh(report)
        return report

    finalized_with_value = make(ReportStatus.finalized, date(2026, 1, 1), {"labor_hours": 4.5})
    make(ReportStatus.finalized, date(2026, 2, 1), {"labor_hours": "not a number"})  # non-numeric — excluded
    make(ReportStatus.in_review, date(2026, 3, 1), {"labor_hours": 9.0})  # not finalized — excluded
    make(ReportStatus.finalized, date(2026, 4, 1), {})  # field absent — excluded
    finalized_second_value = make(ReportStatus.finalized, date(2026, 5, 1), {"labor_hours": 2})

    resp = client.get(f"/instruments/{instrument.id}/trend", params={"field": "labor_hours"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["field"] == "labor_hours"
    point_ids = [p["report_id"] for p in body["points"]]
    assert point_ids == [str(finalized_with_value.id), str(finalized_second_value.id)]
    assert [p["value"] for p in body["points"]] == [4.5, 2]
