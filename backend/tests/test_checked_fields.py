"""A technician marks low-confidence fields as checked on the review screen. The
report remembers which (`checked_fields`) and exposes the newest extraction's
confidences (`field_confidences`), so a saved draft that is reopened can flag
only the fields that still need a look. A fresh extraction starts over.
"""
from __future__ import annotations

from app.services.extraction import ExtractionResult

PDF = ("scan.pdf", b"%PDF-1.4 x", "application/pdf")


def _extracted_report(client, run_worker):
    report = client.post("/reports", json={}).json()
    attachment = client.post(f"/reports/{report['id']}/attachments", files={"file": PDF}).json()
    client.post(f"/attachments/{attachment['id']}/classify")
    run_worker()
    current = client.get(f"/reports/{report['id']}").json()
    if current["template_id"] is None:  # stub guessed below threshold; pick one by hand
        instrument = client.get("/instruments").json()[0]
        template = client.get("/report-templates", params={"model": instrument["model"]}).json()[0]
        client.patch(
            f"/reports/{report['id']}/template",
            json={"instrument_id": instrument["id"], "template_id": template["id"]},
        )
    client.post(f"/attachments/{attachment['id']}/extract")
    run_worker()
    return report["id"], attachment["id"]


def test_a_report_with_no_extraction_has_nothing_checked_and_no_confidences(client):
    report = client.post("/reports", json={}).json()
    assert report["checked_fields"] == []
    assert report["field_confidences"] == {}


def test_the_report_carries_the_newest_extractions_confidences(client, run_worker):
    report_id, _ = _extracted_report(client, run_worker)
    report = client.get(f"/reports/{report_id}").json()
    assert report["checked_fields"] == []
    assert "report_date" in report["field_confidences"]
    assert all(0 <= v <= 1 for v in report["field_confidences"].values())


def test_checked_fields_are_saved_and_come_back_on_the_next_read(client, run_worker):
    report_id, _ = _extracted_report(client, run_worker)

    saved = client.patch(f"/reports/{report_id}/fields", json={"checked_fields": ["report_date", "labor_hours"]})
    assert saved.status_code == 200
    assert saved.json()["checked_fields"] == ["report_date", "labor_hours"]
    assert client.get(f"/reports/{report_id}").json()["checked_fields"] == ["report_date", "labor_hours"]


def test_the_checked_list_replaces_the_old_one_and_drops_duplicates(client, run_worker):
    report_id, _ = _extracted_report(client, run_worker)
    client.patch(f"/reports/{report_id}/fields", json={"checked_fields": ["a", "b"]})

    resp = client.patch(f"/reports/{report_id}/fields", json={"checked_fields": ["b", "b", "c"]})
    assert resp.json()["checked_fields"] == ["b", "c"]


def test_saving_other_fields_leaves_the_checked_list_alone(client, run_worker):
    report_id, _ = _extracted_report(client, run_worker)
    client.patch(f"/reports/{report_id}/fields", json={"checked_fields": ["report_date"]})

    client.patch(f"/reports/{report_id}/fields", json={"report_date": "2025-02-03"})
    assert client.get(f"/reports/{report_id}").json()["checked_fields"] == ["report_date"]

    # An explicit null is "no change" too, not "clear".
    client.patch(f"/reports/{report_id}/fields", json={"checked_fields": None})
    assert client.get(f"/reports/{report_id}").json()["checked_fields"] == ["report_date"]


def test_a_fresh_extraction_clears_what_was_checked(client, run_worker, monkeypatch):
    report_id, attachment_id = _extracted_report(client, run_worker)
    client.patch(f"/reports/{report_id}/fields", json={"checked_fields": ["report_date"]})

    monkeypatch.setattr(
        "app.worker.run_extract",
        lambda attachment, template: ExtractionResult({}, {"report_date": 0.2}, None),
    )
    client.post(f"/attachments/{attachment_id}/extract")
    run_worker()

    report = client.get(f"/reports/{report_id}").json()
    assert report["checked_fields"] == []
    assert report["field_confidences"] == {"report_date": 0.2}
