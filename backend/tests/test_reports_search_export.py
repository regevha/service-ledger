"""Tests for GET /reports (search/list, §7/§9) and its CSV export sibling
GET /reports/export — both are filtered reads over the same Report rows, so
this checks that instrument/report_type/status/date filtering behaves
identically whichever shape you ask for, JSON or CSV, rather than the two
endpoints silently drifting apart.

Report rows are built directly through the ORM (not the classify/extract API)
because the stub classifier's "any other document" branch picks instrument
and report type from a stable hash of the file path — deterministic, but not
something a test can dial to a specific (model, report_type) combination
without reverse-engineering the hash. Reading is all these endpoints do, so
exercising them against hand-built rows is a faithful test of the filtering
logic itself.
"""
from __future__ import annotations

import csv
import io
from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def _make_report(db_session, *, model: str, report_type: ReportType, status: ReportStatus, report_date: date | None, technician: str):
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
        extracted_fields={},
        technician_name=technician,
        report_date=report_date,
    )
    db_session.add(report)
    db_session.commit()
    db_session.refresh(report)
    return report


def test_search_filters_by_report_type_and_status_and_date_range(client, seeded):
    repair = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        status=ReportStatus.finalized,
        report_date=date(2026, 3, 1),
        technician="R. Tester",
    )
    calibration = _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.calibration,
        status=ReportStatus.in_review,
        report_date=date(2026, 6, 15),
        technician="A. Tech",
    )

    all_reports = client.get("/reports").json()
    assert {r["id"] for r in all_reports} == {str(repair.id), str(calibration.id)}
    # Denormalized display fields (§7) resolved from the relationships, not raw ids.
    by_id = {r["id"]: r for r in all_reports}
    assert by_id[str(repair.id)]["instrument_model"] == "LSRFortessa"
    assert by_id[str(repair.id)]["instrument_serial_number"] == "R647794E6092"
    assert by_id[str(repair.id)]["report_type"] == "repair"

    by_type = client.get("/reports", params={"report_type": "calibration"}).json()
    assert [r["id"] for r in by_type] == [str(calibration.id)]

    by_status = client.get("/reports", params={"status": "finalized"}).json()
    assert [r["id"] for r in by_status] == [str(repair.id)]

    by_date_range = client.get("/reports", params={"date_from": "2026-05-01", "date_to": "2026-07-01"}).json()
    assert [r["id"] for r in by_date_range] == [str(calibration.id)]

    by_date_excludes_both = client.get("/reports", params={"date_to": "2026-01-01"}).json()
    assert by_date_excludes_both == []

    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    by_instrument = client.get("/reports", params={"instrument_id": str(instrument.id)}).json()
    assert [r["id"] for r in by_instrument] == [str(repair.id)]


def test_export_csv_applies_the_same_filters_as_search(client, seeded):
    repair = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        status=ReportStatus.finalized,
        report_date=date(2026, 3, 1),
        technician="R. Tester",
    )
    _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.calibration,
        status=ReportStatus.in_review,
        report_date=date(2026, 6, 15),
        technician="A. Tech",
    )

    resp = client.get("/reports/export", params={"report_type": "repair"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in resp.headers["content-disposition"]

    rows = list(csv.DictReader(io.StringIO(resp.text)))
    assert len(rows) == 1
    assert rows[0]["id"] == str(repair.id)
    assert rows[0]["instrument_model"] == "LSRFortessa"
    assert rows[0]["report_type"] == "repair"
    assert rows[0]["technician_name"] == "R. Tester"

    # date_to, like the search endpoint, excludes on report_date — added
    # alongside report_type so export never drifts from what search shows.
    excluded = client.get("/reports/export", params={"date_to": "2026-01-01"})
    assert list(csv.DictReader(io.StringIO(excluded.text))) == []

    # The three filters export_reports had before this round (instrument_id,
    # date_from, status) — never actually unit-tested, only curl-checked by
    # hand — get the same treatment here so a future change can't regress them
    # silently.
    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    by_instrument = client.get("/reports/export", params={"instrument_id": str(instrument.id)})
    assert [r["id"] for r in csv.DictReader(io.StringIO(by_instrument.text))] == [str(repair.id)]

    # date_from=2026-04-01 excludes the repair report (2026-03-01) but keeps
    # the calibration one (2026-06-15).
    by_date_from = client.get("/reports/export", params={"date_from": "2026-04-01"})
    rows_by_date_from = list(csv.DictReader(io.StringIO(by_date_from.text)))
    assert len(rows_by_date_from) == 1
    assert rows_by_date_from[0]["report_type"] == "calibration"

    by_status = client.get("/reports/export", params={"status": "in_review"})
    rows_by_status = list(csv.DictReader(io.StringIO(by_status.text)))
    assert len(rows_by_status) == 1
    assert rows_by_status[0]["status"] == "in_review"
