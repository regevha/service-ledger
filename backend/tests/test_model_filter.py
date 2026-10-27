"""The model filter (`model_id`): the instruments of one model record, taken by the
Reports list and its CSV export, the Analytics endpoints and saved filters, and
shown on the instrument itself so a screen can narrow its lists by model.

Report rows are built through the ORM, as in test_analytics_filters.py.
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType

FORTESSA = "R647794E6092"
ARIA = "P648282B3003"


def _unit(db, serial):
    return db.query(Instrument).filter(Instrument.serial_number == serial).one()


def _report(db, serial, report_type=ReportType.repair, *, when=date(2026, 3, 1), status=ReportStatus.finalized, labor=1):
    instrument = _unit(db, serial)
    template = (
        db.query(ReportTemplate)
        .filter(ReportTemplate.report_type == report_type)
        .filter((ReportTemplate.model == instrument.model) | (ReportTemplate.model.is_(None)))
        .first()
    )
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields={"labor_hours": labor},
        report_date=when,
    )
    db.add(report)
    db.commit()
    return report


def _model_id(db, serial):
    return str(_unit(db, serial).model_id)


def _data(db):
    """Two Fortessa reports (one a draft), one Aria report."""
    fortessa_final = _report(db, FORTESSA, labor=2)
    fortessa_draft = _report(db, FORTESSA, status=ReportStatus.draft, labor=50)
    aria = _report(db, ARIA, labor=5)
    return fortessa_final, fortessa_draft, aria


def _ids(items):
    return {item["id"] for item in items}


# ---------- Reports list and export ----------


def test_the_reports_list_keeps_only_the_reports_of_that_model(client, db_session):
    fortessa_final, fortessa_draft, aria = _data(db_session)
    res = client.get("/reports", params={"model_id": _model_id(db_session, FORTESSA)})
    assert res.status_code == 200
    assert _ids(res.json()) == {str(fortessa_final.id), str(fortessa_draft.id)}

    res = client.get("/reports", params={"model_id": _model_id(db_session, ARIA)})
    assert _ids(res.json()) == {str(aria.id)}


def test_the_model_filter_combines_with_the_other_filters(client, db_session):
    fortessa_final, _draft, _aria = _data(db_session)
    res = client.get("/reports", params={"model_id": _model_id(db_session, FORTESSA), "status": "finalized"})
    assert _ids(res.json()) == {str(fortessa_final.id)}


def test_a_unit_of_another_model_gives_nothing(client, db_session):
    _data(db_session)
    # Both filters must hold: the Aria unit is not a Fortessa.
    res = client.get(
        "/reports",
        params={"model_id": _model_id(db_session, FORTESSA), "instrument_id": str(_unit(db_session, ARIA).id)},
    )
    assert res.status_code == 200
    assert res.json() == []


def test_an_unknown_model_gives_no_reports(client, db_session):
    _data(db_session)
    res = client.get("/reports", params={"model_id": str(uuid.uuid4())})
    assert res.status_code == 200
    assert res.json() == []


def test_a_model_id_that_is_not_an_id_is_refused(client):
    assert client.get("/reports", params={"model_id": "not-a-uuid"}).status_code == 422


def test_the_csv_export_matches_the_list(client, db_session):
    fortessa_final, fortessa_draft, _aria = _data(db_session)
    params = {"model_id": _model_id(db_session, FORTESSA)}
    res = client.get("/reports/export", params=params)
    assert res.status_code == 200
    rows = list(csv.DictReader(io.StringIO(res.text)))
    assert {r["id"] for r in rows} == {str(fortessa_final.id), str(fortessa_draft.id)}
    assert {r["id"] for r in rows} == _ids(client.get("/reports", params=params).json())


# ---------- Analytics ----------


def test_the_fleet_analytics_count_only_that_model(client, db_session):
    _data(db_session)
    everything = client.get("/analytics/fleet").json()
    assert everything["finalized_report_count"] == 2

    body = client.get("/analytics/fleet", params={"model_id": _model_id(db_session, FORTESSA)}).json()
    assert body["finalized_report_count"] == 1  # the Fortessa draft never counts
    assert body["total_labor_hours"] == 2.0

    body = client.get("/analytics/fleet", params={"model_id": _model_id(db_session, ARIA)}).json()
    assert body["finalized_report_count"] == 1
    assert body["total_labor_hours"] == 5.0


def test_the_model_comparison_lists_only_the_units_of_that_model(client, db_session):
    _data(db_session)
    res = client.get("/analytics/models", params={"model_id": _model_id(db_session, FORTESSA)})
    assert res.status_code == 200
    units = [u["serial_number"] for group in res.json() for u in group["units"]]
    assert units == [FORTESSA]


def test_the_analytics_model_filter_combines_with_an_instrument(client, db_session):
    _data(db_session)
    body = client.get(
        "/analytics/fleet",
        params={"model_id": _model_id(db_session, FORTESSA), "instrument_id": str(_unit(db_session, ARIA).id)},
    ).json()
    assert body["finalized_report_count"] == 0


# ---------- The instrument carries its model ----------


def test_an_instrument_shows_which_model_record_it_belongs_to(client, db_session):
    by_serial = {i["serial_number"]: i for i in client.get("/instruments").json()}
    assert by_serial[FORTESSA]["model_id"] == _model_id(db_session, FORTESSA)
    assert by_serial[FORTESSA]["model_id"] != by_serial[ARIA]["model_id"]
    one = client.get(f"/instruments/{by_serial[FORTESSA]['id']}").json()
    assert one["model_id"] == by_serial[FORTESSA]["model_id"]


# ---------- Saved filters ----------


def _save(client, name, **filters):
    return client.post("/saved-report-filters", json={"name": name, "filters": filters})


def _new_model(client, name="Spare Sorter"):
    res = client.post("/instrument-models", json={"name": name, "manufacturer": "BD", "instrument_type": "facs"})
    assert res.status_code == 201, res.text
    return res.json()


def test_a_model_can_be_saved_as_a_filter_and_returns_the_same_rows(client, db_session):
    fortessa_final, fortessa_draft, _aria = _data(db_session)
    model_id = _model_id(db_session, FORTESSA)
    res = _save(client, "Fortessas", model_id=model_id)
    assert res.status_code == 201
    saved = res.json()
    assert saved["filters"] == {"model_id": model_id}
    assert saved["stale"] is False and saved["stale_keys"] == []
    assert _ids(client.get("/reports", params=saved["filters"]).json()) == {
        str(fortessa_final.id),
        str(fortessa_draft.id),
    }


def test_a_model_alone_counts_as_a_criterion(client, db_session):
    assert _save(client, "Only a model", model_id=_model_id(db_session, FORTESSA)).status_code == 201


def test_an_unknown_model_is_refused_at_save(client):
    res = _save(client, "Ghost", model_id=str(uuid.uuid4()))
    assert res.status_code == 422
    assert "model" in res.json()["detail"].lower()


def test_a_filter_goes_stale_when_its_model_is_deleted(client):
    spare = _new_model(client)
    saved = _save(client, "Spares", model_id=spare["id"], status="finalized").json()
    assert saved["stale"] is False
    assert client.delete(f"/instrument-models/{spare['id']}").status_code == 204
    item = client.get("/saved-report-filters").json()["items"][0]
    assert item["stale"] is True
    assert item["stale_keys"] == ["model_id"]
    assert item["filters"]["status"] == "finalized"  # the rest is kept


def test_the_stale_keys_name_each_missing_thing(client):
    spare = _new_model(client)
    inst = client.post(
        "/instruments",
        json={"name": "Temp", "model": "Temp Model", "manufacturer": "BD", "serial_number": "TEMP-1"},
    ).json()
    _save(client, "Both", model_id=spare["id"], instrument_id=inst["id"])
    client.delete(f"/instrument-models/{spare['id']}")
    client.delete(f"/instruments/{inst['id']}")
    item = client.get("/saved-report-filters").json()["items"][0]
    assert sorted(item["stale_keys"]) == ["instrument_id", "model_id"]


def test_merging_a_model_moves_the_saved_filters_that_named_it(client):
    source = _new_model(client, "Spare Sorter")
    target = _new_model(client, "Spare Sorter II")
    other = _new_model(client, "Unrelated")
    _save(client, "Follows", model_id=source["id"], status="finalized")
    _save(client, "Stays", model_id=other["id"])
    res = client.post(f"/instrument-models/{source['id']}/merge", json={"into_id": target["id"]})
    assert res.status_code == 200, res.text

    items = {i["name"]: i for i in client.get("/saved-report-filters").json()["items"]}
    assert items["Follows"]["filters"] == {"model_id": target["id"], "status": "finalized"}
    assert items["Follows"]["stale"] is False
    assert items["Stays"]["filters"] == {"model_id": other["id"]}
