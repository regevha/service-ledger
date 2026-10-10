"""The same file bytes as a report that was already read are refused at
upload (409 with the existing report's id) instead of being read again.
Anything weaker stays a warning: a report that was never read, the same
report, different bytes, a matching work order only.
"""
from __future__ import annotations

from app.schemas import ClassificationGuess

PDF = ("scan.pdf", b"%PDF-1.4 same bytes", "application/pdf")


def _confident(monkeypatch):
    monkeypatch.setattr(
        "app.services.classification._stub_classify",
        lambda attachment, instruments: (
            ClassificationGuess(value="LSRFortessa", confidence=0.99),
            ClassificationGuess(value="repair", confidence=0.99),
            None,
        ),
    )


def _read_report(client, run_worker, monkeypatch, file=PDF):
    """A report taken through upload, classify and extract."""
    _confident(monkeypatch)
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": file}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    assert client.get(f"/reports/{report['id']}").json()["status"] == "extracted"
    return report


def _upload(client, report_id, file=PDF):
    return client.post(f"/reports/{report_id}/attachments", files={"file": file})


def test_the_same_file_as_a_read_report_is_refused_with_the_existing_report(client, run_worker, monkeypatch):
    existing = _read_report(client, run_worker, monkeypatch)
    second = client.post("/reports", json={}).json()

    response = _upload(client, second["id"])

    assert response.status_code == 409
    body = response.json()
    assert body["existing_report_id"] == existing["id"]
    assert "already on file" in body["detail"]


def test_a_refused_upload_stores_nothing_and_makes_no_job(client, run_worker, monkeypatch, db_session):
    from sqlalchemy import text

    _read_report(client, run_worker, monkeypatch)
    second = client.post("/reports", json={}).json()
    attachments_before = db_session.execute(text("SELECT count(*) FROM attachments")).scalar_one()

    _upload(client, second["id"])

    assert db_session.execute(text("SELECT count(*) FROM attachments")).scalar_one() == attachments_before
    assert client.get(f"/reports/{second['id']}").json()["attachments"] == []


def test_finalized_and_in_review_reports_also_count_as_read(client, run_worker, monkeypatch):
    existing = _read_report(client, run_worker, monkeypatch)
    client.patch(f"/reports/{existing['id']}/fields", json={"extracted_fields": {}})  # -> in_review
    assert client.get(f"/reports/{existing['id']}").json()["status"] == "in_review"
    assert _upload(client, client.post("/reports", json={}).json()["id"]).status_code == 409

    assert client.post(f"/reports/{existing['id']}/finalize").status_code == 200
    assert _upload(client, client.post("/reports", json={}).json()["id"]).status_code == 409


def test_a_report_that_was_never_read_does_not_block_the_same_file(client):
    first = client.post("/reports", json={}).json()
    assert _upload(client, first["id"]).status_code == 201  # draft only: classify/extract never ran

    second = client.post("/reports", json={}).json()
    response = _upload(client, second["id"])

    assert response.status_code == 201
    assert response.json()["duplicate_report_ids"] == [first["id"]]  # still just a warning


def test_deleting_the_read_report_lets_the_file_be_loaded_again(client, run_worker, monkeypatch):
    existing = _read_report(client, run_worker, monkeypatch)
    second = client.post("/reports", json={}).json()
    assert _upload(client, second["id"]).status_code == 409

    assert client.delete(f"/reports/{existing['id']}").status_code == 204

    assert _upload(client, second["id"]).status_code == 201


def test_different_bytes_are_not_refused(client, run_worker, monkeypatch):
    _read_report(client, run_worker, monkeypatch)
    second = client.post("/reports", json={}).json()

    response = _upload(client, second["id"], ("scan.pdf", b"%PDF-1.4 other bytes", "application/pdf"))

    assert response.status_code == 201


def test_reattaching_to_the_report_that_already_holds_the_file_is_not_refused(client, run_worker, monkeypatch):
    existing = _read_report(client, run_worker, monkeypatch)

    # Same report, same bytes: not "another report", so not turned away.
    assert _upload(client, existing["id"]).status_code == 201
