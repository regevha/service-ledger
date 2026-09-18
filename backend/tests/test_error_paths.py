"""Error-path coverage for the reports/attachments routers (§9).

The happy-path tests (test_document_first_flow.py) never exercise a single
404/409/422 branch — every id they pass is one they just created. This file
closes that gap: each of these guards is a real safety check (don't extract
against an unresolved template, don't silently 200 on a typo'd id), so a
regression here would only ever surface in production, not in CI, without
tests that deliberately pass a bad id.
"""
from __future__ import annotations

import uuid


def test_health_check():
    # The literal endpoint used all session to tell "backend is actually up"
    # apart from "container looks fine but nothing's listening" — worth
    # locking in given how often that distinction has mattered this week.
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_upload_attachment_404_on_missing_report(client):
    resp = client.post(
        f"/reports/{uuid.uuid4()}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    assert resp.status_code == 404


def test_classify_404_on_missing_attachment(client):
    resp = client.post(f"/attachments/{uuid.uuid4()}/classify")
    assert resp.status_code == 404


def test_extract_404_on_missing_attachment(client):
    resp = client.post(f"/attachments/{uuid.uuid4()}/extract")
    assert resp.status_code == 404


def test_extract_409_before_template_is_resolved(client):
    """§4: extraction needs a resolved instrument/template. Uploading without
    classifying (or classifying but landing in the uncertain branch) must
    reject extraction rather than run against report.template_id=None."""
    report = client.post("/reports", json={}).json()
    upload = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("scan.pdf", b"%PDF-1.4 x", "application/pdf")},
    )
    attachment = upload.json()

    resp = client.post(f"/attachments/{attachment['id']}/extract")
    assert resp.status_code == 409


def test_get_report_404(client):
    resp = client.get(f"/reports/{uuid.uuid4()}")
    assert resp.status_code == 404


def test_confirm_template_404_on_missing_report(client):
    resp = client.patch(
        f"/reports/{uuid.uuid4()}/template",
        json={"instrument_id": str(uuid.uuid4()), "template_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 404


def test_confirm_template_422_on_bogus_ids(client):
    report = client.post("/reports", json={}).json()
    resp = client.patch(
        f"/reports/{report['id']}/template",
        json={"instrument_id": str(uuid.uuid4()), "template_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 422


def test_update_fields_404_on_missing_report(client):
    resp = client.patch(f"/reports/{uuid.uuid4()}/fields", json={"technician_name": "Nobody"})
    assert resp.status_code == 404


def test_update_fields_applies_top_level_columns_not_just_extracted_fields(client):
    """update_report_fields has two code paths: merge extracted_fields, and a
    plain setattr loop for every other column (technician_name,
    service_actions, parts_replaced, next_service_due, report_date). Every
    existing test only exercises the first — this covers the second."""
    report = client.post("/reports", json={"technician_name": "Original Name"}).json()
    resp = client.patch(
        f"/reports/{report['id']}/fields",
        json={
            "technician_name": "R. Tester",
            "service_actions": "Replaced O-ring",
            "parts_replaced": "O-ring x1",
            "next_service_due": "2027-01-01",
            "report_date": "2026-03-01",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["technician_name"] == "R. Tester"
    assert body["service_actions"] == "Replaced O-ring"
    assert body["parts_replaced"] == "O-ring x1"
    assert body["next_service_due"] == "2027-01-01"
    assert body["report_date"] == "2026-03-01"


def test_update_fields_422_on_explicit_null_extracted_fields(client):
    """Regression test: an explicit `"extracted_fields": null` used to slip
    past the merge guard (which only special-cased a non-null dict) and reach
    the generic setattr loop, writing NULL onto a NOT NULL column. FastAPI's
    response validation then 500'd on the way out — but only after
    db.commit() had already persisted the NULL, so the report was left
    permanently unreadable (every later GET 500s the same way). This must be
    rejected before it ever reaches the database, and the report must still
    be perfectly readable afterward."""
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()

    resp = client.patch(f"/reports/{report['id']}/fields", json={"extracted_fields": None})
    assert resp.status_code == 422

    # The report itself must be untouched and still readable — this is the
    # part that silently failed before the fix (a 500 here, forever).
    still_readable = client.get(f"/reports/{report['id']}")
    assert still_readable.status_code == 200
    assert still_readable.json()["extracted_fields"] == {}


def test_finalize_404_on_missing_report(client):
    resp = client.post(f"/reports/{uuid.uuid4()}/finalize")
    assert resp.status_code == 404


def test_extraction_job_roundtrip_and_404(client, run_worker):
    """GET /extraction-jobs/{id} (§9's polling endpoint) had zero coverage —
    nothing in the suite ever fetches a job back by id, only indirectly via
    the report it updated. Also covers the job's `pending` shape right after
    submission, before the worker (run_worker here) has touched it."""
    report = client.post("/reports", json={}).json()
    upload = client.post(
        "/reports/{}/attachments".format(report["id"]),
        files={"file": ("aria_pm_2026.pdf", b"%PDF-1.4 fake pm scan", "application/pdf")},
    )
    attachment = upload.json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    job = client.post(f"/attachments/{attachment['id']}/extract").json()
    assert job["status"] == "pending"

    still_pending = client.get(f"/extraction-jobs/{job['id']}")
    assert still_pending.status_code == 200
    assert still_pending.json()["status"] == "pending"

    run_worker()

    fetched = client.get(f"/extraction-jobs/{job['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == job["id"]
    assert fetched.json()["status"] == "succeeded"

    missing = client.get(f"/extraction-jobs/{uuid.uuid4()}")
    assert missing.status_code == 404
