"""The first-run sample report (services/samples.py, routers/samples.py): AC-01 to AC-05 of
docs/features/first-run-sample/PRODUCT.md. One test per place a sample must stay out of (AC-03)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from app import models, seed_templates
from app.config import get_settings
from app.services import samples
from app.services.classification import ClassificationError, classify
from tests.conftest import TestSessionLocal


def _open(client):
    response = client.post("/sample-report")
    assert response.status_code == 201, response.text
    return response.json()


def _finalized_real_report(db, instrument):
    template = db.query(models.ReportTemplate).filter(models.ReportTemplate.report_type == models.ReportType.repair).first()
    report = models.Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=models.ReportStatus.finalized,
        finalized_at=datetime.now(timezone.utc),
        extracted_fields={"labor_hours": 1},
        original_fields={"labor_hours": 1},
    )
    db.add(report)
    db.commit()
    return report


def test_open_makes_the_report_instrument_and_places(client):
    body = _open(client)
    assert body["is_sample"] is True
    assert body["status"] == "extracted"
    assert body["extracted_fields"]["labor_hours"] == 2.5
    assert body["report_date"] == "2026-03-12"
    assert body["field_confidences"]["root_cause"] < 0.7
    assert len(body["attachments"]) == 1
    with TestSessionLocal() as db:
        instrument = db.get(models.Instrument, body["instrument_id"])
        assert instrument.is_sample and instrument.serial_number == samples.SAMPLE_SERIAL
        assert instrument.place.is_sample and instrument.place.parent.is_sample
        assert instrument.model_record.is_sample


def test_the_scan_opens(client):
    attachment = _open(client)["attachments"][0]
    response = client.get(f"/attachments/{attachment['id']}/file")
    assert response.status_code == 200
    assert response.content.startswith(b"%PDF")


def test_stored_result_has_one_or_two_flagged_fields(client):
    body = _open(client)
    threshold = get_settings().field_confidence_threshold
    with TestSessionLocal() as db:
        job = (
            db.query(models.ExtractionJob)
            .filter(models.ExtractionJob.attachment_id == body["attachments"][0]["id"], models.ExtractionJob.kind == models.ExtractionJobKind.extract)
            .one()
        )
        flagged = [k for k, v in job.field_confidences.items() if v < threshold]
    assert 1 <= len(flagged) <= 2


def test_stored_values_use_only_the_repair_templates_field_names(client):
    body = _open(client)
    names = {f["name"] for f in seed_templates.REPAIR_FIELDS}
    assert set(body["extracted_fields"]) <= names


def test_nothing_is_created_until_it_is_opened(client):
    with TestSessionLocal() as db:
        assert db.query(models.Report).filter(models.Report.is_sample).count() == 0
        assert db.query(models.Instrument).filter(models.Instrument.is_sample).count() == 0
        assert db.query(models.Place).filter(models.Place.is_sample).count() == 0
        assert db.query(models.InstrumentModel).filter(models.InstrumentModel.is_sample).count() == 0


def test_opening_again_returns_the_same_sample(client):
    first = _open(client)
    again = client.post("/sample-report")
    assert again.status_code == 200
    assert again.json()["id"] == first["id"]
    with TestSessionLocal() as db:
        assert db.query(models.Report).filter(models.Report.is_sample).count() == 1


def test_missing_repair_template_is_a_clear_409(client):
    with TestSessionLocal() as db:
        db.query(models.ReportTemplate).delete()
        db.commit()
    response = client.post("/sample-report")
    assert response.status_code == 409
    assert "repair" in response.json()["detail"]


def test_cannot_be_finalized_or_read_again(client):
    body = _open(client)
    assert client.post(f"/reports/{body['id']}/finalize").status_code == 409
    attachment_id = body["attachments"][0]["id"]
    assert client.post(f"/attachments/{attachment_id}/classify").status_code == 409
    assert client.post(f"/attachments/{attachment_id}/extract").status_code == 409
    assert client.get(f"/reports/{body['id']}").json()["status"] == "extracted"


def test_corrections_can_be_saved(client):
    body = _open(client)
    response = client.patch(f"/reports/{body['id']}/fields", json={"extracted_fields": {**body["extracted_fields"], "labor_hours": 3}})
    assert response.status_code == 200, response.text
    assert response.json()["extracted_fields"]["labor_hours"] == 3


def test_delete_removes_everything_and_the_scan_file(client):
    body = _open(client)
    folder = get_settings().attachment_storage_path / body["id"]
    assert folder.exists()
    assert client.delete("/sample-report").status_code == 204
    assert not folder.exists()
    with TestSessionLocal() as db:
        for model in (models.Report, models.Instrument, models.Place, models.InstrumentModel):
            assert db.query(model).filter(model.is_sample.is_(True)).count() == 0
        assert db.query(models.Attachment).count() == 0
        assert db.query(models.ExtractionJob).count() == 0
    assert client.get(f"/reports/{body['id']}").status_code == 404


def test_delete_with_no_sample_is_fine(client):
    assert client.delete("/sample-report").status_code == 204


def test_delete_never_touches_real_data(client):
    with TestSessionLocal() as db:
        instruments = db.query(models.Instrument).count()
        places = db.query(models.Place).count()
        records = db.query(models.InstrumentModel).count()
        real = _finalized_real_report(db, db.query(models.Instrument).first())
        real_id = real.id
    _open(client)
    assert client.delete("/sample-report").status_code == 204
    with TestSessionLocal() as db:
        assert db.query(models.Instrument).count() == instruments
        assert db.query(models.Place).count() == places
        assert db.query(models.InstrumentModel).count() == records
        assert db.get(models.Report, real_id) is not None


def test_remove_sample_data_function_removes_all_and_reports_whether_any(client):
    _open(client)
    with TestSessionLocal() as db:
        assert samples.remove_sample_data(db) is True
        assert samples.remove_sample_data(db) is False


# ---- AC-03: a sample stays out of every list, count and export of real data ----

def test_not_in_the_reports_list_any_status(client):
    sample = _open(client)
    for query in ("", "?status=extracted", "?status=in_review", "?status=draft", "?status=finalized"):
        ids = [r["id"] for r in client.get(f"/reports{query}").json()]
        assert sample["id"] not in ids, query


def test_not_in_the_csv_export(client):
    _open(client)
    text = client.get("/reports/export").text
    assert "DEMO-0001" not in text and "Demo Sorter" not in text and "nozzle" not in text.lower()


def test_not_in_search_by_word_or_number(client):
    _open(client)
    assert client.get("/reports?q=nozzle").json() == []
    assert client.get("/reports?number_field=labor_hours&number_op=gte&number_value=2").json() == []


def test_not_in_instruments_models_places(client):
    _open(client)
    assert all(i["serial_number"] != samples.SAMPLE_SERIAL for i in client.get("/instruments").json())
    assert all(m["name"] != samples.SAMPLE_MODEL for m in client.get("/instrument-models").json())
    names = [p["name"] for p in client.get("/places").json()]
    assert samples.SAMPLE_INSTITUTION not in names and samples.SAMPLE_ROOM not in names


def test_not_in_repair_counts(client):
    sample = _open(client)
    assert all(row["instrument_id"] != sample["instrument_id"] for row in client.get("/instruments/repair-counts").json())


def test_not_in_home_figures(client):
    _open(client)
    body = client.get("/home/summary").json()
    assert body["waiting"]["count"] == 0
    assert body["finalized"] == {"this_month": 0, "last_month": 0}
    assert body["read_without_edits"]["reports"] == 0


def test_not_in_analytics(client):
    sample = _open(client)
    fleet = client.get("/analytics/fleet").json()
    assert samples.SAMPLE_SERIAL not in str(fleet) and sample["instrument_id"] not in str(fleet)
    assert samples.SAMPLE_MODEL not in str(client.get("/analytics/models").json())


def test_not_in_maintenance_badges(client):
    from app.services.maintenance import last_maintenance_dates

    sample = _open(client)
    with TestSessionLocal() as db:
        # even if it somehow were finalized preventive maintenance, a sample report is not counted
        report = db.get(models.Report, sample["id"])
        pm = db.query(models.ReportTemplate).filter(models.ReportTemplate.report_type == models.ReportType.preventive_maintenance).first()
        report.template_id = pm.id
        report.status = models.ReportStatus.finalized
        db.commit()
        assert last_maintenance_dates(db, [report.instrument_id]) == {}


def test_not_in_duplicate_checks(client):
    from app.services.duplicates import find_read_copy

    sample = _open(client)
    with TestSessionLocal() as db:
        attachment = db.get(models.Attachment, sample["attachments"][0]["id"])
        attachment.content_sha256 = "a" * 64
        attachment.work_order_number = "99999999"
        db.commit()
        assert find_read_copy(db, "a" * 64, exclude_report_id=uuid.uuid4()) is None
    other = client.post("/reports", json={}).json()
    assert client.get(f"/reports/{other['id']}/duplicates").json() == []


def test_not_in_the_template_usage_counts(client):
    _open(client)
    assert all(row["report_count"] == 0 for row in client.get("/report-templates/usage").json())


def test_not_offered_to_the_classifier_as_fleet(db_session):
    seed_templates.seed(db_session)
    report, _ = samples.create_sample(db_session)
    attachment = report.attachments[0]
    with pytest.raises(ClassificationError):
        classify(db_session, attachment)


def test_the_scan_renders_as_a_page_image(client):
    attachment = _open(client)["attachments"][0]
    response = client.get(f"/attachments/{attachment['id']}/pages/1")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/")


def test_a_template_used_only_by_the_sample_can_still_be_deleted(client):
    sample = _open(client)
    response = client.delete(f"/report-templates/{sample['template_id']}")
    assert response.status_code == 204, response.text
    assert client.get(f"/reports/{sample['id']}").status_code == 404
