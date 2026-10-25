"""Coverage for app/routers/instruments.py — POST /instruments and the
GET /instruments/{id}/trend series endpoint had no tests at all before this
file (0/17 and 0/? relevant statements, per `pytest --cov`), despite
`instrument_trend` being real filtering/aggregation logic (only finalized
reports, only numeric values for the requested key) that backs
instrument-timeline-demo.html.
"""
from __future__ import annotations

import uuid
from datetime import date

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def test_create_instrument(client):
    resp = client.post(
        "/instruments",
        json={"name": "Test Cytometer", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "TC-0001", "location": "Room 9"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["model"] == "TestModel-9000"
    assert body["serial_number"] == "TC-0001"
    assert body["status"] == "active"


def test_create_instrument_conflicts_on_duplicate_serial(client):
    payload = {"name": "Dup", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "TC-0002"}
    first = client.post("/instruments", json=payload)
    assert first.status_code == 201
    second = client.post("/instruments", json=payload)
    assert second.status_code == 409


def test_instrument_trend_404_on_missing_instrument(client):
    resp = client.get(f"/instruments/{uuid.uuid4()}/trend", params={"field": "labor_hours"})
    assert resp.status_code == 404


def test_instrument_trend_only_counts_finalized_reports_with_numeric_values(client, seeded):
    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    template = seeded.query(ReportTemplate).filter(ReportTemplate.report_type == ReportType.repair).first()

    def make(status, report_date, extracted_fields):
        report = Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=status,
            extracted_fields=extracted_fields,
            report_date=report_date,
        )
        seeded.add(report)
        seeded.commit()
        seeded.refresh(report)
        return report

    finalized_with_value = make(ReportStatus.finalized, date(2026, 1, 1), {"labor_hours": 4.5})
    make(ReportStatus.finalized, date(2026, 2, 1), {"labor_hours": "not a number"})  # non-numeric — excluded
    make(ReportStatus.in_review, date(2026, 3, 1), {"labor_hours": 9.0})  # not finalized — excluded
    make(ReportStatus.finalized, date(2026, 4, 1), {})  # field absent — excluded
    finalized_second_value = make(ReportStatus.finalized, date(2026, 5, 1), {"labor_hours": 2})

    resp = client.get(f"/instruments/{instrument.id}/trend", params={"field": "labor_hours"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["field"] == "labor_hours"
    point_ids = [p["report_id"] for p in body["points"]]
    assert point_ids == [str(finalized_with_value.id), str(finalized_second_value.id)]
    assert [p["value"] for p in body["points"]] == [4.5, 2]


def test_instrument_trend_excludes_booleans(client, seeded):
    # bool is a subclass of int in Python — services/analytics.py's
    # _as_number hits the same trap; this is the trend endpoint's own
    # regression test for the identical exclusion.
    instrument = seeded.query(Instrument).filter(Instrument.model == "LSRFortessa").one()
    template = seeded.query(ReportTemplate).filter(ReportTemplate.report_type == ReportType.repair).first()
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=ReportStatus.finalized,
        extracted_fields={"labor_hours": True},
        report_date=date(2026, 1, 1),
    )
    seeded.add(report)
    seeded.commit()

    resp = client.get(f"/instruments/{instrument.id}/trend", params={"field": "labor_hours"})
    assert resp.status_code == 200
    assert resp.json()["points"] == []

def _numeric_template(db):
    """A template with numeric fields of both kinds — the seeded templates only have labor_hours."""
    template = ReportTemplate(
        instrument_type="facs",
        report_type=ReportType.repair,
        model="Trend test model",
        field_schema={
            "fields": [
                {"name": "baseline_cv_percent", "type": "number[detector]", "unit": "%", "notes": None},
                {"name": "pmt_voltages", "type": "number[detector]", "unit": "V", "notes": None},
                {"name": "fluidics_pressure_psi", "type": "number", "unit": "psi", "notes": None},
                {"name": "compensation_matrix_updated", "type": "boolean", "unit": None, "notes": None},
                {"name": "cst_beads_lot", "type": "text", "unit": None, "notes": None},
            ]
        },
    )
    db.add(template)
    db.commit()
    db.refresh(template)
    return template


def test_instrument_trend_supports_number_detector_maps(client, seeded):
    instrument = seeded.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    template = _numeric_template(seeded)

    def make(extracted_fields, report_date):
        report = Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=ReportStatus.finalized,
            extracted_fields=extracted_fields,
            report_date=report_date,
        )
        seeded.add(report)
        seeded.commit()
        seeded.refresh(report)
        return report

    # Mixed-quality dict: a stray non-numeric entry and a boolean entry are
    # dropped, but the point still contributes since real numbers remain.
    mixed = make({"baseline_cv_percent": {"violet": 3.1, "blue": "n/a", "red": True}}, date(2026, 1, 1))
    # A dict with nothing numeric in it contributes no point at all.
    make({"baseline_cv_percent": {"violet": "unreadable"}}, date(2026, 2, 1))
    clean = make({"baseline_cv_percent": {"violet": 3.4, "blue": 2.9}}, date(2026, 3, 1))

    resp = client.get(f"/instruments/{instrument.id}/trend", params={"field": "baseline_cv_percent"})
    assert resp.status_code == 200
    body = resp.json()
    assert [p["report_id"] for p in body["points"]] == [str(mixed.id), str(clean.id)]
    assert body["points"][0]["value"] == {"violet": 3.1}
    assert body["points"][1]["value"] == {"violet": 3.4, "blue": 2.9}


def test_instrument_trend_fields_404_on_missing_instrument(client):
    resp = client.get(f"/instruments/{uuid.uuid4()}/trend-fields")
    assert resp.status_code == 404


def test_instrument_trend_fields_is_empty_with_no_finalized_reports(client, seeded):
    instrument = seeded.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    resp = client.get(f"/instruments/{instrument.id}/trend-fields")
    assert resp.status_code == 200
    assert resp.json() == []


def test_instrument_trend_fields_derives_from_real_templates_only(client, seeded):
    # Only the used template's numeric fields (baseline_cv_percent, pmt_voltages:
    # number[detector]; fluidics_pressure_psi: number) should show up — not
    # compensation_matrix_updated (boolean) or cst_beads_lot (text), and not
    # any field from a template this instrument's reports never actually used.
    instrument = seeded.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    template = _numeric_template(seeded)
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=ReportStatus.finalized,
        extracted_fields={"fluidics_pressure_psi": 4.9},
        report_date=date(2026, 1, 1),
    )
    seeded.add(report)
    seeded.commit()

    resp = client.get(f"/instruments/{instrument.id}/trend-fields")
    assert resp.status_code == 200
    body = resp.json()
    names = {f["name"] for f in body}
    assert names == {"baseline_cv_percent", "pmt_voltages", "fluidics_pressure_psi"}
    by_name = {f["name"]: f for f in body}
    assert by_name["baseline_cv_percent"]["type"] == "number[detector]"
    assert by_name["fluidics_pressure_psi"]["type"] == "number"
    assert by_name["fluidics_pressure_psi"]["unit"] == "psi"


def test_instrument_trend_fields_ignores_non_finalized_and_templateless_reports(client, seeded):
    instrument = seeded.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    template = _numeric_template(seeded)
    seeded.add(
        Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=ReportStatus.in_review,
            extracted_fields={"fluidics_pressure_psi": 4.9},
        )
    )
    seeded.add(Report(instrument_id=instrument.id, template_id=None, status=ReportStatus.finalized, extracted_fields={}))
    seeded.commit()

    resp = client.get(f"/instruments/{instrument.id}/trend-fields")
    assert resp.status_code == 200
    assert resp.json() == []


# ---------- PATCH /instruments/{id} ----------


def test_update_instrument_partial_update_only_touches_provided_fields(client):
    created = client.post(
        "/instruments",
        json={"name": "Edit Me", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0001", "location": "Room 1"},
    ).json()

    resp = client.patch(f"/instruments/{created['id']}", json={"location": "Room 2"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["location"] == "Room 2"
    # Everything not sent stays exactly as it was.
    assert body["name"] == "Edit Me"
    assert body["model"] == "TestModel-9000"
    assert body["serial_number"] == "PATCH-0001"
    assert body["status"] == "active"


def test_update_instrument_can_change_status(client):
    created = client.post(
        "/instruments", json={"name": "Retiree", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0002"}
    ).json()

    resp = client.patch(f"/instruments/{created['id']}", json={"status": "retired"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "retired"


def test_update_instrument_can_change_every_editable_field_at_once(client):
    created = client.post(
        "/instruments", json={"name": "Old Name", "model": "OldModel", "manufacturer": "TestCo", "serial_number": "PATCH-0003"}
    ).json()

    resp = client.patch(
        f"/instruments/{created['id']}",
        json={
            "name": "New Name",
            "model": "NewModel",
            "serial_number": "PATCH-0003-NEW",
            "location": "New Room",
            "status": "maintenance",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["name"] == "New Name"
    assert body["model"] == "NewModel"
    assert body["serial_number"] == "PATCH-0003-NEW"
    assert body["location"] == "New Room"
    assert body["status"] == "maintenance"


def test_update_instrument_404_on_missing_instrument(client):
    resp = client.patch(f"/instruments/{uuid.uuid4()}", json={"location": "Nowhere"})
    assert resp.status_code == 404


def test_update_instrument_rejects_explicit_null_on_a_required_field(client):
    created = client.post(
        "/instruments", json={"name": "No Null", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0004"}
    ).json()

    resp = client.patch(f"/instruments/{created['id']}", json={"name": None})
    assert resp.status_code == 422


def test_update_instrument_conflicts_on_duplicate_serial_number(client):
    client.post(
        "/instruments", json={"name": "First", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0005-A"}
    ).json()
    second = client.post(
        "/instruments", json={"name": "Second", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0005-B"}
    ).json()

    resp = client.patch(f"/instruments/{second['id']}", json={"serial_number": "PATCH-0005-A"})
    assert resp.status_code == 409
    # The conflict must not have partially applied.
    unchanged = client.get("/instruments").json()
    still_b = next(i for i in unchanged if i["id"] == second["id"])
    assert still_b["serial_number"] == "PATCH-0005-B"


def test_update_instrument_allows_resubmitting_its_own_current_serial_number(client):
    created = client.post(
        "/instruments", json={"name": "Self", "model": "TestModel-9000", "manufacturer": "TestCo", "serial_number": "PATCH-0006"}
    ).json()

    # Re-sending the instrument's own serial number (e.g. a form that always
    # submits every field) must not trip the "already exists" check against
    # itself.
    resp = client.patch(f"/instruments/{created['id']}", json={"serial_number": "PATCH-0006", "location": "Room 3"})
    assert resp.status_code == 200
    assert resp.json()["location"] == "Room 3"


def test_get_instrument_returns_one_instrument(client):
    listed = client.get("/instruments").json()[0]

    response = client.get(f"/instruments/{listed['id']}")

    assert response.status_code == 200
    assert response.json() == listed


def test_get_unknown_instrument_returns_404(client):
    import uuid

    assert client.get(f"/instruments/{uuid.uuid4()}").status_code == 404


def test_get_instrument_rejects_a_malformed_id(client):
    assert client.get("/instruments/not-a-uuid").status_code == 422


# ---------- manufacturer ----------


def test_manufacturer_is_required_for_a_new_instrument(client):
    missing = client.post("/instruments", json={"name": "No Maker", "model": "M1", "serial_number": "MFR-0001"})
    assert missing.status_code == 422
    assert "manufacturer" in missing.text
    blank = client.post(
        "/instruments", json={"name": "Blank", "model": "M3", "serial_number": "MFR-0003", "manufacturer": "   "}
    )
    assert blank.status_code == 422
    assert client.get("/instruments").json() == [] or all(
        i["serial_number"] not in ("MFR-0001", "MFR-0003") for i in client.get("/instruments").json()
    )


def test_manufacturer_is_trimmed_and_returned(client):
    made = client.post(
        "/instruments", json={"name": "Maker", "model": "M2", "serial_number": "MFR-0002", "manufacturer": "  Beckman Coulter "}
    ).json()
    assert made["manufacturer"] == "Beckman Coulter"  # trimmed
    assert client.get(f"/instruments/{made['id']}").json()["manufacturer"] == "Beckman Coulter"
    listed = {i["serial_number"]: i for i in client.get("/instruments").json()}
    assert listed["MFR-0002"]["manufacturer"] == "Beckman Coulter"


def test_update_manufacturer_sets_changes_and_clears_it(client):
    created = client.post(
        "/instruments", json={"name": "Edit Maker", "model": "M4", "manufacturer": "TestCo", "serial_number": "MFR-0004", "location": "Room 9"}
    ).json()

    set_ = client.patch(f"/instruments/{created['id']}", json={"manufacturer": "Cytek"}).json()
    assert set_["manufacturer"] == "Cytek"
    assert set_["location"] == "Room 9"  # other fields untouched

    # A PATCH that does not mention it leaves it alone…
    assert client.patch(f"/instruments/{created['id']}", json={"location": "Room 1"}).json()["manufacturer"] == "Cytek"
    # …and an explicit null (or blank) clears it.
    assert client.patch(f"/instruments/{created['id']}", json={"manufacturer": None}).json()["manufacturer"] is None
    client.patch(f"/instruments/{created['id']}", json={"manufacturer": "Cytek"})
    assert client.patch(f"/instruments/{created['id']}", json={"manufacturer": " "}).json()["manufacturer"] is None


# ---------- distributor ----------


def test_distributor_is_optional_trimmed_and_returned(client):
    plain = client.post(
        "/instruments", json={"name": "No Dist", "model": "D1", "manufacturer": "Cytek", "serial_number": "DIST-0001"}
    )
    assert plain.status_code == 201
    assert plain.json()["distributor"] is None

    made = client.post(
        "/instruments",
        json={"name": "With Dist", "model": "D2", "manufacturer": "Beckman Coulter", "serial_number": "DIST-0002", "distributor": "  Rhenium "},
    ).json()
    assert made["distributor"] == "Rhenium"  # trimmed
    assert client.get(f"/instruments/{made['id']}").json()["distributor"] == "Rhenium"
    listed = {i["serial_number"]: i for i in client.get("/instruments").json()}
    assert listed["DIST-0002"]["distributor"] == "Rhenium"
    assert listed["DIST-0001"]["distributor"] is None


def test_a_blank_distributor_on_create_means_none(client):
    made = client.post(
        "/instruments",
        json={"name": "Blank Dist", "model": "D3", "manufacturer": "Cytek", "serial_number": "DIST-0003", "distributor": "   "},
    ).json()
    assert made["distributor"] is None


def test_update_distributor_sets_changes_and_clears_it(client):
    created = client.post(
        "/instruments", json={"name": "Edit Dist", "model": "D4", "manufacturer": "Cytek", "serial_number": "DIST-0004", "location": "Room 2"}
    ).json()

    assert client.patch(f"/instruments/{created['id']}", json={"distributor": "almog diagnostic"}).json()["distributor"] == "almog diagnostic"
    # Other edits leave it alone, and so does a distributor edit leave the maker alone.
    after = client.patch(f"/instruments/{created['id']}", json={"location": "Room 3"}).json()
    assert after["distributor"] == "almog diagnostic" and after["manufacturer"] == "Cytek"
    assert client.patch(f"/instruments/{created['id']}", json={"distributor": "Rhenium"}).json()["distributor"] == "Rhenium"
    assert client.patch(f"/instruments/{created['id']}", json={"distributor": None}).json()["distributor"] is None
    client.patch(f"/instruments/{created['id']}", json={"distributor": "Rhenium"})
    assert client.patch(f"/instruments/{created['id']}", json={"distributor": " "}).json()["distributor"] is None


# ---------- institution ----------


def test_institution_is_optional_trimmed_returned_and_editable(client):
    plain = client.post(
        "/instruments", json={"name": "No Inst", "model": "I1", "manufacturer": "Cytek", "serial_number": "INST-0001"}
    ).json()
    assert plain["institution"] is None

    made = client.post(
        "/instruments",
        json={"name": "With Inst", "model": "I2", "manufacturer": "BD", "serial_number": "INST-0002", "institution": "  Bar-Ilan University "},
    ).json()
    assert made["institution"] == "Bar-Ilan University"
    assert client.get(f"/instruments/{made['id']}").json()["institution"] == "Bar-Ilan University"
    listed = {i["serial_number"]: i for i in client.get("/instruments").json()}
    assert listed["INST-0002"]["institution"] == "Bar-Ilan University"
    assert listed["INST-0001"]["institution"] is None

    # Edits: set, leave alone on other edits, blank clears it.
    assert client.patch(f"/instruments/{plain['id']}", json={"institution": "Tel Aviv University"}).json()["institution"] == "Tel Aviv University"
    assert client.patch(f"/instruments/{plain['id']}", json={"location": "Room 9"}).json()["institution"] == "Tel Aviv University"
    assert client.patch(f"/instruments/{plain['id']}", json={"institution": "  "}).json()["institution"] is None
