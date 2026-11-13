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
import json
from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def _make_report(
    db_session,
    *,
    model: str,
    report_type: ReportType,
    status: ReportStatus,
    report_date: date | None,
    technician: str,
    extracted_fields: dict | None = None,
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
    installation = _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.installation_upgrade,
        status=ReportStatus.in_review,
        report_date=date(2026, 6, 15),
        technician="A. Tech",
    )

    all_reports = client.get("/reports").json()
    assert {r["id"] for r in all_reports} == {str(repair.id), str(installation.id)}
    # Denormalized display fields (§7) resolved from the relationships, not raw ids.
    by_id = {r["id"]: r for r in all_reports}
    assert by_id[str(repair.id)]["instrument_model"] == "LSRFortessa"
    assert by_id[str(repair.id)]["instrument_serial_number"] == "R647794E6092"
    assert by_id[str(repair.id)]["report_type"] == "repair"

    by_type = client.get("/reports", params={"report_type": "installation_upgrade"}).json()
    assert [r["id"] for r in by_type] == [str(installation.id)]

    by_status = client.get("/reports", params={"status": "finalized"}).json()
    assert [r["id"] for r in by_status] == [str(repair.id)]

    by_date_range = client.get("/reports", params={"date_from": "2026-05-01", "date_to": "2026-07-01"}).json()
    assert [r["id"] for r in by_date_range] == [str(installation.id)]

    by_date_excludes_both = client.get("/reports", params={"date_to": "2026-01-01"}).json()
    assert by_date_excludes_both == []

    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    by_instrument = client.get("/reports", params={"instrument_id": str(instrument.id)}).json()
    assert [r["id"] for r in by_instrument] == [str(repair.id)]


def test_search_filters_by_technician_case_insensitive_partial_match(client, seeded):
    """technician is ILIKE, not equality (§7) — a caller typing "tester" or
    "TESTER" should find "R. Tester" without knowing the exact stored
    casing/spelling, unlike the fixed-dropdown filters above."""
    repair = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        status=ReportStatus.finalized,
        report_date=date(2026, 3, 1),
        technician="R. Tester",
    )
    installation = _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.installation_upgrade,
        status=ReportStatus.in_review,
        report_date=date(2026, 6, 15),
        technician="A. Tech",
    )

    by_partial = client.get("/reports", params={"technician": "tester"}).json()
    assert [r["id"] for r in by_partial] == [str(repair.id)]

    by_different_case = client.get("/reports", params={"technician": "A. TECH"}).json()
    assert [r["id"] for r in by_different_case] == [str(installation.id)]

    by_no_match = client.get("/reports", params={"technician": "nonexistent"}).json()
    assert by_no_match == []


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
        report_type=ReportType.installation_upgrade,
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
    # the installation one (2026-06-15).
    by_date_from = client.get("/reports/export", params={"date_from": "2026-04-01"})
    rows_by_date_from = list(csv.DictReader(io.StringIO(by_date_from.text)))
    assert len(rows_by_date_from) == 1
    assert rows_by_date_from[0]["report_type"] == "installation_upgrade"

    by_status = client.get("/reports/export", params={"status": "in_review"})
    rows_by_status = list(csv.DictReader(io.StringIO(by_status.text)))
    assert len(rows_by_status) == 1
    assert rows_by_status[0]["status"] == "in_review"

    # Same ILIKE partial/case-insensitive match as search_reports (§7) —
    # exported rows must always match what the search screen shows.
    by_technician = client.get("/reports/export", params={"technician": "r. tester"})
    rows_by_technician = list(csv.DictReader(io.StringIO(by_technician.text)))
    assert [r["id"] for r in rows_by_technician] == [str(repair.id)]


def test_export_csv_extracted_fields_column_is_valid_json(client, seeded):
    """Regression test: extracted_fields_json used to be built with str() on
    the dict, which produces Python repr syntax (True/None/single-quoted
    strings) rather than JSON — looks right for a report with only string
    values (every prior test here used extracted_fields={}), but
    json.loads() throws on the very first boolean, null, or nested value,
    despite the column being named and documented as JSON."""
    fields = {
        "compensation_matrix_updated": True,
        "root_cause": None,
        "components_replaced": ["injector O-ring", "sheath filter"],
    }
    report = _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        status=ReportStatus.finalized,
        report_date=date(2026, 3, 1),
        technician="R. Tester",
        extracted_fields=fields,
    )

    resp = client.get("/reports/export")
    rows = list(csv.DictReader(io.StringIO(resp.text)))
    assert len(rows) == 1
    assert rows[0]["id"] == str(report.id)

    # The whole point: this must parse as JSON, not raise on the boolean/
    # null/list values a real report can have.
    assert json.loads(rows[0]["extracted_fields_json"]) == fields


def _seed_many(db_session, n):
    made = [
        _make_report(db_session, model="FACSAria III", report_type=ReportType.repair, status=ReportStatus.finalized,
                     report_date=date(2026, 1, 1), technician=f"Tech {i}", extracted_fields={"fault_description": f"scan number {i}"})
        for i in range(n)
    ]
    return made


def test_list_pages_with_limit_and_offset_and_reports_the_total(client, seeded):
    made = _seed_many(seeded, 5)
    everything = client.get("/reports")
    assert len(everything.json()) == 5 and everything.headers["X-Total-Count"] == "5"  # no limit: unchanged

    first = client.get("/reports", params={"limit": 2})
    second = client.get("/reports", params={"limit": 2, "offset": 2})
    last = client.get("/reports", params={"limit": 2, "offset": 4})
    assert [len(r.json()) for r in (first, second, last)] == [2, 2, 1]
    assert all(r.headers["X-Total-Count"] == "5" for r in (first, second, last))
    ids = [row["id"] for r in (first, second, last) for row in r.json()]
    assert len(set(ids)) == 5 and set(ids) == {str(r.id) for r in made}  # no overlap, nothing missed
    assert ids == [row["id"] for row in everything.json()]  # same order as the unpaged list


def test_total_counts_matches_not_the_page_and_a_page_past_the_end_is_empty(client, seeded):
    _seed_many(seeded, 3)
    page = client.get("/reports", params={"limit": 1, "offset": 10})
    assert page.json() == [] and page.headers["X-Total-Count"] == "3"
    assert client.get("/reports", params={"technician": "Tech 1", "limit": 5}).headers["X-Total-Count"] == "1"


def test_limit_must_be_between_1_and_the_maximum(client, seeded):
    assert client.get("/reports", params={"limit": 0}).status_code == 422
    assert client.get("/reports", params={"limit": 501}).status_code == 422
    assert client.get("/reports", params={"limit": 500}).status_code == 200


def test_ranked_text_search_pages_too(client, seeded):
    _seed_many(seeded, 4)
    full = client.get("/reports", params={"q": "scan"}).json()
    assert len(full) == 4
    paged = client.get("/reports", params={"q": "scan", "limit": 2, "offset": 2})
    assert [r["id"] for r in paged.json()] == [r["id"] for r in full[2:4]]
    assert paged.headers["X-Total-Count"] == "4"


def test_one_report_as_a_list_row(client, seeded):
    made = _seed_many(seeded, 2)
    row = client.get(f"/reports/{made[1].id}/item")
    assert row.status_code == 200
    assert row.json() == next(r for r in client.get("/reports").json() if r["id"] == str(made[1].id))
    assert client.get("/reports/00000000-0000-0000-0000-000000000000/item").status_code == 404
