"""Saved report filters (proposal-saved-filters.md): a global list of at most
five named combinations of the six Reports-list filters."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

from app import models
from app.routers.saved_filters import MAX_SAVED_FILTERS


def _save(client, name="Repairs", **filters):
    return client.post("/saved-report-filters", json={"name": name, "filters": filters or {"report_type": "repair"}})


def _instrument_id(client):
    return client.get("/instruments").json()[0]["id"]


def test_create_list_and_delete(client):
    res = _save(client, "Repairs this quarter", report_type="repair", date_from="2026-07-01", date_to="2026-09-30")
    assert res.status_code == 201
    body = res.json()
    assert body["name"] == "Repairs this quarter"
    # Dates are stored exactly as picked, and only the set criteria are kept.
    assert body["filters"] == {"report_type": "repair", "date_from": "2026-07-01", "date_to": "2026-09-30"}
    assert body["stale"] is False

    listing = client.get("/saved-report-filters").json()
    assert listing["cap"] == MAX_SAVED_FILTERS == 5
    assert [i["name"] for i in listing["items"]] == ["Repairs this quarter"]

    assert client.delete(f"/saved-report-filters/{body['id']}").status_code == 204
    assert client.get("/saved-report-filters").json()["items"] == []
    assert client.delete(f"/saved-report-filters/{body['id']}").status_code == 404


def test_name_is_trimmed_and_must_not_be_blank(client):
    assert _save(client, "   Spaced   ").json()["name"] == "Spaced"
    for bad in ("", "   "):
        assert _save(client, bad).status_code == 422
    assert _save(client, "x" * 61).status_code == 422


def test_names_are_unique_ignoring_case_and_spaces(client):
    assert _save(client, "Fortessa").status_code == 201
    assert _save(client, "fortessa").status_code == 409
    assert _save(client, "  FORTESSA ").status_code == 409
    assert _save(client, "Fortessa 2").status_code == 201


def test_needs_at_least_one_criterion(client):
    assert client.post("/saved-report-filters", json={"name": "Empty", "filters": {}}).status_code == 422
    # A technician box that is only spaces counts as not set.
    assert _save(client, "Blank tech", technician="   ").status_code == 422


def test_only_the_six_known_criteria_are_accepted(client):
    # Free-text search is deliberately not saveable, and no other key is.
    for key in ("q", "search", "whatever"):
        res = client.post("/saved-report-filters", json={"name": "Bad", "filters": {"report_type": "repair", key: "x"}})
        assert res.status_code == 422, key


def test_values_are_validated(client):
    assert _save(client, "A", report_type="nope").status_code == 422
    assert _save(client, "B", status="nope").status_code == 422
    assert _save(client, "C", date_from="not-a-date").status_code == 422
    assert _save(client, "D", date_from="2026-09-30", date_to="2026-07-01").status_code == 422
    assert _save(client, "E", instrument_id="not-a-uuid").status_code == 422
    assert client.get("/saved-report-filters").json()["items"] == []


def test_unknown_instrument_is_refused_at_save(client):
    res = _save(client, "Ghost", instrument_id="00000000-0000-0000-0000-000000000000")
    assert res.status_code == 422


def test_cap_of_five(client):
    for n in range(MAX_SAVED_FILTERS):
        assert _save(client, f"Filter {n}").status_code == 201
    res = _save(client, "One too many")
    assert res.status_code == 409
    assert "Delete one first" in res.json()["detail"]
    # Deleting one frees a slot.
    first = client.get("/saved-report-filters").json()["items"][-1]
    assert client.delete(f"/saved-report-filters/{first['id']}").status_code == 204
    assert _save(client, "Now it fits").status_code == 201


def test_simultaneous_saves_cannot_exceed_the_cap(client):
    for n in range(MAX_SAVED_FILTERS - 1):
        assert _save(client, f"Filter {n}").status_code == 201

    def attempt(n):
        return _save(client, f"Racer {n}").status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(attempt, range(6)))
    assert codes.count(201) == 1
    assert codes.count(409) == 5
    assert len(client.get("/saved-report-filters").json()["items"]) == MAX_SAVED_FILTERS


def test_filter_goes_stale_when_its_instrument_is_deleted(client):
    inst = client.post(
        "/instruments",
        json={"name": "Temp", "model": "Fortessa", "manufacturer": "BD", "serial_number": "TEMP-1"},
    ).json()
    saved = _save(client, "Temp unit", instrument_id=inst["id"], status="finalized").json()
    assert saved["stale"] is False
    assert client.delete(f"/instruments/{inst['id']}").status_code == 204
    item = client.get("/saved-report-filters").json()["items"][0]
    assert item["stale"] is True
    # It still counts toward the cap and keeps its other criteria.
    assert item["filters"]["status"] == "finalized"


def test_stored_filter_returns_the_same_rows_as_the_same_query_by_hand(client, db_session):
    inst_id = _instrument_id(client)
    db_session.add_all(
        [
            models.Report(instrument_id=inst_id, status=models.ReportStatus.finalized, technician_name="Dana Levi"),
            models.Report(instrument_id=inst_id, status=models.ReportStatus.draft, technician_name="Dana Levi"),
        ]
    )
    db_session.commit()
    saved = _save(client, "Dana final", instrument_id=inst_id, status="finalized", technician="dana").json()
    by_hand = client.get("/reports", params=saved["filters"]).json()
    typed = client.get(
        "/reports", params={"instrument_id": inst_id, "status": "finalized", "technician": "dana"}
    ).json()
    assert [r["id"] for r in by_hand] == [r["id"] for r in typed]
    assert len(by_hand) == 1


def test_save_waits_for_the_cap_lock(client, db_session):
    """Deterministic guard for the race protection: while another transaction
    holds the saved-filters advisory lock, a save must wait for it instead of
    counting and inserting on its own."""
    import time

    from sqlalchemy import text

    from app.routers.saved_filters import _LOCK_KEY

    db_session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_KEY})
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_save, client, "Waiter")
        time.sleep(0.6)
        assert not future.done(), "save did not wait for the lock"
        db_session.rollback()  # releases the lock
        assert future.result(timeout=5).status_code == 201
