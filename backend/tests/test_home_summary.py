"""GET /home/summary: reports waiting, finalized this month against last, and how much of the reading was kept."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app import models
from app.services.home_summary import home_summary
from tests.conftest import TestSessionLocal


def _report(db, status, **kw):
    r = models.Report(status=status, extracted_fields=kw.pop("extracted_fields", {}), **kw)
    db.add(r)
    db.commit()
    return r


def _now():
    return datetime.now(timezone.utc)


def test_empty_database(client):
    body = client.get("/home/summary").json()
    assert body["waiting"] == {"count": 0, "oldest_created_at": None}
    assert body["finalized"] == {"this_month": 0, "last_month": 0}
    assert body["read_without_edits"]["fields"] == 0


def test_waiting_counts_extracted_and_in_review_and_finds_the_oldest(client):
    with TestSessionLocal() as db:
        old = _now() - timedelta(days=6)
        _report(db, models.ReportStatus.extracted, created_at=old)
        _report(db, models.ReportStatus.in_review)
        _report(db, models.ReportStatus.draft)
        _report(db, models.ReportStatus.finalized, finalized_at=_now())
    body = client.get("/home/summary").json()
    assert body["waiting"]["count"] == 2
    oldest = datetime.fromisoformat(body["waiting"]["oldest_created_at"])
    assert abs((oldest - old).total_seconds()) < 5


def test_finalized_this_month_and_last_month_use_the_finalizing_day(client):
    today = date(2026, 11, 15)
    with TestSessionLocal() as db:
        at = lambda d: datetime(d.year, d.month, d.day, 12, tzinfo=timezone.utc)  # noqa: E731
        _report(db, models.ReportStatus.finalized, finalized_at=at(date(2026, 11, 1)))
        _report(db, models.ReportStatus.finalized, finalized_at=at(date(2026, 11, 14)))
        _report(db, models.ReportStatus.finalized, finalized_at=at(date(2026, 10, 31)))
        _report(db, models.ReportStatus.finalized, finalized_at=at(date(2026, 10, 1)))
        _report(db, models.ReportStatus.finalized, finalized_at=at(date(2026, 9, 30)))
        out = home_summary(db, today)
    assert (out.finalized.this_month, out.finalized.last_month) == (2, 2)


def test_last_month_across_a_year_boundary(client):
    with TestSessionLocal() as db:
        _report(db, models.ReportStatus.finalized, finalized_at=datetime(2025, 12, 20, tzinfo=timezone.utc))
        out = home_summary(db, date(2026, 1, 5))
    assert (out.finalized.this_month, out.finalized.last_month) == (0, 1)


def test_read_without_edits_counts_only_fields_the_reading_filled(client):
    with TestSessionLocal() as db:
        _report(
            db,
            models.ReportStatus.finalized,
            finalized_at=_now(),
            original_fields={"a": "29.40", "b": "Dana ", "c": "wrong", "d": "", "e": None},
            extracted_fields={"a": "29.40", "b": "Dana", "c": "right", "d": "typed by hand", "e": "also by hand"},
        )
        # Finalized before the copy existed: no original, left out.
        _report(db, models.ReportStatus.finalized, finalized_at=_now(), extracted_fields={"a": "1"})
        # Too old.
        _report(
            db,
            models.ReportStatus.finalized,
            finalized_at=_now() - timedelta(days=45),
            original_fields={"a": "1"},
            extracted_fields={"a": "2"},
        )
        # Not finalized yet.
        _report(db, models.ReportStatus.in_review, original_fields={"a": "1"}, extracted_fields={"a": "2"})
    r = client.get("/home/summary").json()["read_without_edits"]
    assert (r["reports"], r["fields"], r["unchanged"], r["days"]) == (1, 3, 2, 30)


def test_a_table_field_counts_as_one_field(client):
    rows = [{"part": "O-ring", "qty": 2}]
    with TestSessionLocal() as db:
        _report(
            db,
            models.ReportStatus.finalized,
            finalized_at=_now(),
            original_fields={"parts": rows},
            extracted_fields={"parts": rows + [{"part": "Filter", "qty": 1}]},
        )
    r = client.get("/home/summary").json()["read_without_edits"]
    assert (r["fields"], r["unchanged"]) == (1, 0)


def test_extraction_stores_the_original_reading(client, run_worker, monkeypatch):
    from tests.test_delete_report import _extracted_report

    report, _ = _extracted_report(client, run_worker, monkeypatch)
    with TestSessionLocal() as db:
        row = db.get(models.Report, report["id"])
        assert row.original_fields == row.extracted_fields
        assert row.original_fields
    name = next(iter(report["extracted_fields"]))
    client.patch(f"/reports/{report['id']}/fields", json={"extracted_fields": {name: "changed by hand"}})
    with TestSessionLocal() as db:
        row = db.get(models.Report, report["id"])
        assert row.original_fields != row.extracted_fields
