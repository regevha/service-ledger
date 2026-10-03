"""Report.report_date — the service-visit date — is read off the document by
the same extraction call as the template's fields (services/extraction.py)
and written by the worker. Before this, nothing in the app ever set it, so
the date filters, trend chart and CSV export only worked for seeded data.
Parsing of Claude's raw answer is covered in test_live_claude_parsing.py;
these tests cover the stub path and what the worker does with the result.
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services.extraction import ExtractionResult

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


def _report_ready_to_extract(client, run_worker):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    report = client.get(f"/reports/{report['id']}").json()
    if report["template_id"] is None:  # stub guessed below threshold; pick one by hand
        instrument = client.get("/instruments").json()[0]
        template = client.get("/report-templates", params={"model": instrument["model"]}).json()[0]
        client.patch(
            f"/reports/{report['id']}/template",
            json={"instrument_id": instrument["id"], "template_id": template["id"]},
        )
    return report["id"], attachment["id"]


def test_extraction_sets_report_date_and_reports_its_confidence(client, run_worker):
    report_id, attachment_id = _report_ready_to_extract(client, run_worker)

    job = client.post(f"/attachments/{attachment_id}/extract").json()
    run_worker()

    report = client.get(f"/reports/{report_id}").json()
    assert report["report_date"] is not None
    assert date.today() - timedelta(days=366) <= date.fromisoformat(report["report_date"]) <= date.today()
    confidences = client.get(f"/extraction-jobs/{job['id']}").json()["field_confidences"]
    assert 0 <= confidences["report_date"] <= 1

    # ...and the date filters now find a report created entirely in-app.
    on_day = {"date_from": report["report_date"], "date_to": report["report_date"]}
    assert report_id in [r["id"] for r in client.get("/reports", params=on_day).json()]


def test_extraction_with_no_readable_date_keeps_the_existing_one(client, run_worker, monkeypatch):
    report_id, attachment_id = _report_ready_to_extract(client, run_worker)
    client.patch(f"/reports/{report_id}/fields", json={"report_date": "2025-02-03"})

    monkeypatch.setattr(
        "app.worker.run_extract",
        lambda attachment, template: ExtractionResult({}, {"report_date": 0.0}, None),
    )
    client.post(f"/attachments/{attachment_id}/extract")
    run_worker()

    assert client.get(f"/reports/{report_id}").json()["report_date"] == "2025-02-03"


def test_template_fields_cannot_be_named_report_date(client):
    resp = client.post(
        "/report-templates",
        json={
            "instrument_type": "facs",
            "report_type": "calibration",
            "model": "ReservedNameModel",
            "fields": [{"name": "report_date", "type": "date"}],
        },
    )
    assert resp.status_code == 422
    assert "reserved" in resp.text
