"""GET /instruments/repair-counts: finalized repair reports per instrument in a date range."""
from __future__ import annotations

from datetime import date

from app import models


def _report(db, instrument, *, status=models.ReportStatus.finalized, report_type=models.ReportType.repair, day=None):
    template = db.query(models.ReportTemplate).filter(models.ReportTemplate.report_type == report_type).first()
    db.add(models.Report(instrument_id=instrument.id, template_id=template.id, status=status, report_date=day, extracted_fields={}))
    db.commit()


def _counts(client, **params):
    resp = client.get("/instruments/repair-counts", params=params)
    assert resp.status_code == 200, resp.text
    return {row["instrument_id"]: row["repairs"] for row in resp.json()}


def test_counts_finalized_repairs_only_and_lists_every_instrument(client, db_session):
    first, second = db_session.query(models.Instrument).limit(2).all()
    _report(db_session, first, day=date(2026, 3, 1))
    _report(db_session, first, day=date(2026, 5, 1))
    _report(db_session, first, status=models.ReportStatus.draft, day=date(2026, 5, 2))
    _report(db_session, first, report_type=models.ReportType.preventive_maintenance, day=date(2026, 5, 3))
    counts = _counts(client)
    assert counts[str(first.id)] == 2
    assert counts[str(second.id)] == 0
    assert len(counts) == db_session.query(models.Instrument).count()


def test_the_date_range_limits_the_count(client, db_session):
    instrument = db_session.query(models.Instrument).first()
    _report(db_session, instrument, day=date(2025, 12, 31))
    _report(db_session, instrument, day=date(2026, 1, 1))
    _report(db_session, instrument, day=date(2026, 6, 30))
    _report(db_session, instrument, day=None)
    assert _counts(client, date_from="2026-01-01", date_to="2026-12-31")[str(instrument.id)] == 2
    assert _counts(client, date_to="2025-12-31")[str(instrument.id)] == 1


def test_a_repair_count_question_targets_the_instruments_list(client, monkeypatch):
    from app.services import report_query_model
    from app.services.report_query_parse import Parsed

    def fake(text, known, today, db=None):
        return Parsed(filters={"repairs_op": "gt", "repairs_count": "2"}, understood=[{"key": "repairs", "label": "Above 2 repairs"}], source="ai")

    monkeypatch.setattr(report_query_model, "parse", fake)
    body = client.post("/reports/parse-search", json={"text": "instruments with more than 2 repairs"}).json()
    assert body["target"] == "instruments"
    assert body["filters"] == {"repairs_op": "gt", "repairs_count": "2"}


def test_an_ordinary_question_targets_the_reports_list(client):
    assert client.post("/reports/parse-search", json={"text": "repairs last month"}).json()["target"] == "reports"


def test_the_rules_alone_read_a_repair_count_without_the_model(client, monkeypatch):
    from app.services import report_query_model

    monkeypatch.setattr(report_query_model.settings, "use_live_claude", False)
    body = client.post("/reports/parse-search", json={"text": "instruments with more than 2 repairs"}).json()
    assert body["source"] == "rules"
    assert body["target"] == "instruments"
    assert body["filters"] == {"repairs_op": "gt", "repairs_count": "2"}
    assert body["understood"] == [{"key": "repairs", "label": "Above 2 repairs"}]
