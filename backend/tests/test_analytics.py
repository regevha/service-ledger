"""Tests for GET /analytics/fleet — the fleet-wide roll-ups computed by
services/analytics.py. Report rows are built directly through the ORM, same
reasoning as test_reports_search_export.py's own _make_report: this endpoint
is a pure read over already-stored data, so hand-built rows are a faithful
way to pin exact field combinations (a missing labor_hours, a non-numeric
qty, a report with no result field filled in) that classify/extract's stub
hash can't reliably reproduce.
"""
from __future__ import annotations

from app.models import Instrument, Report, ReportStatus, ReportTemplate, ReportType


def _make_report(
    db_session,
    *,
    model: str,
    report_type: ReportType,
    status: ReportStatus = ReportStatus.finalized,
    extracted_fields: dict | None = None,
):
    instrument = db_session.query(Instrument).filter(Instrument.model == model).one()
    template = (
        db_session.query(ReportTemplate)
        .filter(ReportTemplate.report_type == report_type)
        .filter((ReportTemplate.model == model) | (ReportTemplate.model.is_(None)))
        .first()
    )
    assert template is not None, f"No seeded template for {report_type}/{model}"
    report = Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=status,
        extracted_fields=extracted_fields if extracted_fields is not None else {},
    )
    db_session.add(report)
    db_session.commit()
    db_session.refresh(report)
    return report


def test_empty_fleet_returns_zeroed_rollups_for_every_instrument(client, seeded):
    """No finalized reports at all yet — every instrument in the fleet still
    appears (report_count=0, total_labor_hours=0.0), and both tracked report
    types appear in pass_fail_by_report_type at zero rather than being
    missing keys."""
    resp = client.get("/analytics/fleet")
    assert resp.status_code == 200
    body = resp.json()

    assert body["parts_replaced"] == []
    assert body["total_labor_hours"] == 0.0
    assert body["labor_hours_by_fault_category"] == {}
    assert {row["model"] for row in body["labor_hours_by_instrument"]} == {
        "FACSAria III",
        "LSRFortessa",
        "FACSDiscover S8",
        "Cytek Aurora",
        "CytoFLEX S",
    }
    assert all(row["report_count"] == 0 and row["total_labor_hours"] == 0.0 for row in body["labor_hours_by_instrument"])
    assert body["pass_fail_by_report_type"] == {
        "repair": {"pass_count": 0, "fail_count": 0, "other_count": 0, "total": 0},
        "preventive_maintenance": {"pass_count": 0, "fail_count": 0, "other_count": 0, "total": 0},
    }


def test_parts_replaced_aggregates_across_reports_by_name_and_number(client, seeded):
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={
            "components_replaced": [{"part_name": "Face Seal", "part_number": "641922", "qty": 1}],
            "labor_hours": 2,
        },
    )
    _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.preventive_maintenance,
        extracted_fields={
            "components_replaced": [
                {"part_name": "Face Seal", "part_number": "641922", "qty": 2},
                {"part_name": "PM Kit", "part_number": "34363910", "qty": 1},
            ],
            "labor_hours": 3.5,
        },
    )
    # A different part_number under the same name is a different part, not
    # the same one — must not merge into the "Face Seal"/641922 bucket.
    _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.repair,
        extracted_fields={"components_replaced": [{"part_name": "Face Seal", "part_number": "999999", "qty": 1}]},
    )

    body = client.get("/analytics/fleet").json()
    by_key = {(p["part_name"], p["part_number"]): p for p in body["parts_replaced"]}

    face_seal = by_key[("Face Seal", "641922")]
    assert face_seal["times_replaced"] == 2
    assert face_seal["total_qty"] == 3

    pm_kit = by_key[("PM Kit", "34363910")]
    assert pm_kit["times_replaced"] == 1
    assert pm_kit["total_qty"] == 1

    other_face_seal = by_key[("Face Seal", "999999")]
    assert other_face_seal["total_qty"] == 1

    # Sorted by total_qty descending.
    assert [p["total_qty"] for p in body["parts_replaced"]] == sorted(
        (p["total_qty"] for p in body["parts_replaced"]), reverse=True
    )


def test_labor_hours_rolled_up_by_instrument_and_fault_category(client, seeded):
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"labor_hours": 3, "fault_category": "fluidics"},
    )
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"labor_hours": 1.5, "fault_category": "optics"},
    )
    _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.preventive_maintenance,
        extracted_fields={"labor_hours": 4},  # PM has no fault_category at all
    )
    # Installation/upgrade reports are not labor-tracked — even if a stray
    # labor_hours value showed up here, it must not be counted.
    _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.installation_upgrade,
        extracted_fields={"labor_hours": 999},
    )

    body = client.get("/analytics/fleet").json()
    assert body["total_labor_hours"] == 8.5
    assert body["labor_hours_by_fault_category"] == {"fluidics": 3.0, "optics": 1.5}

    by_model = {row["model"]: row for row in body["labor_hours_by_instrument"]}
    assert by_model["FACSAria III"]["total_labor_hours"] == 4.5
    assert by_model["FACSAria III"]["report_count"] == 2
    assert by_model["LSRFortessa"]["total_labor_hours"] == 4.0
    assert by_model["LSRFortessa"]["report_count"] == 1
    assert by_model["FACSDiscover S8"]["total_labor_hours"] == 0.0
    assert by_model["FACSDiscover S8"]["report_count"] == 0


def test_pass_fail_tallies_missing_and_non_binary_results_as_other(client, seeded):
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"retest_result": "pass"},
    )
    _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.repair,
        extracted_fields={"retest_result": "fail"},
    )
    _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.repair,
        extracted_fields={"retest_result": "not retested"},
    )
    # No retest_result key at all — still counted as "other", not silently
    # dropped from the total.
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair, extracted_fields={})
    _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.preventive_maintenance,
        extracted_fields={"verification_result": "pass"},
    )

    body = client.get("/analytics/fleet").json()
    assert body["pass_fail_by_report_type"]["repair"] == {
        "pass_count": 1,
        "fail_count": 1,
        "other_count": 2,
        "total": 4,
    }
    assert body["pass_fail_by_report_type"]["preventive_maintenance"] == {
        "pass_count": 1,
        "fail_count": 0,
        "other_count": 0,
        "total": 1,
    }


def test_non_finalized_reports_never_contribute(client, seeded):
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        status=ReportStatus.in_review,
        extracted_fields={
            "labor_hours": 100,
            "fault_category": "software",
            "retest_result": "pass",
            "components_replaced": [{"part_name": "Should not count", "part_number": "X", "qty": 1}],
        },
    )

    body = client.get("/analytics/fleet").json()
    assert body["parts_replaced"] == []
    assert body["total_labor_hours"] == 0.0
    assert body["labor_hours_by_fault_category"] == {}
    assert body["pass_fail_by_report_type"]["repair"]["total"] == 0


def test_non_numeric_and_boolean_labor_hours_and_qty_are_ignored_not_miscounted(client, seeded):
    """A malformed value (string labor_hours, a boolean sneaking into a
    numeric field) shouldn't crash the endpoint or get silently coerced to a
    misleading number — it's just excluded from the sum, same as a missing
    value would be."""
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={
            "labor_hours": "unknown",
            "components_replaced": [{"part_name": "Weird Qty Part", "part_number": "Q1", "qty": True}],
        },
    )
    _make_report(
        seeded,
        model="FACSAria III",
        report_type=ReportType.repair,
        extracted_fields={"labor_hours": 2},
    )

    resp = client.get("/analytics/fleet")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_labor_hours"] == 2.0

    weird_part = next(p for p in body["parts_replaced"] if p["part_name"] == "Weird Qty Part")
    assert weird_part["times_replaced"] == 1
    assert weird_part["total_qty"] == 0.0  # the boolean qty didn't count, but the part still shows up


def test_labor_hours_tolerate_text_numbers_and_a_renamed_labor_field(client, seeded):
    # "3.5" saved as text, and a template whose labor field is called something else.
    _make_report(
        seeded, model="FACSAria III", report_type=ReportType.repair, extracted_fields={"labor_hours": "3.5"}
    )
    _make_report(
        seeded,
        model="LSRFortessa",
        report_type=ReportType.preventive_maintenance,
        extracted_fields={"Labor time (hours)": 2},
    )
    body = client.get("/analytics/fleet").json()
    assert body["total_labor_hours"] == 5.5
    by_model = {row["model"]: row for row in body["labor_hours_by_instrument"]}
    assert by_model["FACSAria III"]["total_labor_hours"] == 3.5
    assert by_model["LSRFortessa"]["total_labor_hours"] == 2.0
    assert body["reports_without_labor_hours"] == 0


def test_reports_that_add_no_hours_are_counted_so_the_page_can_say_so(client, seeded):
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair, extracted_fields={"labor_hours": 2})
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair, extracted_fields={"labor_hours": "n/a"})
    _make_report(seeded, model="LSRFortessa", report_type=ReportType.preventive_maintenance, extracted_fields={})
    # Installation/upgrade never counts for hours and is not "missing" them either.
    _make_report(seeded, model="CytoFLEX S", report_type=ReportType.installation_upgrade, extracted_fields={})
    body = client.get("/analytics/fleet").json()
    assert body["total_labor_hours"] == 2.0
    assert body["reports_without_labor_hours"] == 2


def test_the_instrument_rollup_carries_the_institution(client, seeded):
    inst = seeded.query(Instrument).filter(Instrument.model == "FACSAria III").one()
    inst.institution = "Bar-Ilan University"
    seeded.commit()
    body = client.get("/analytics/fleet").json()
    by_model = {row["model"]: row for row in body["labor_hours_by_instrument"]}
    assert by_model["FACSAria III"]["institution"] == "Bar-Ilan University"
    assert by_model["LSRFortessa"]["institution"] == "Demo Institution"  # as seeded


# ---------- the Reports-tab filters on analytics: status, lab manager, search ----------


def _tech_report(db, tech, status, fields=None):
    r = _make_report(db, model="FACSAria III", report_type=ReportType.repair, status=status, extracted_fields=fields or {"labor_hours": 2})
    r.technician_name = tech
    db.commit()
    return r


def test_status_filter_defaults_to_finalized_and_can_include_drafts(client, seeded):
    _tech_report(seeded, "Dana", ReportStatus.finalized, {"labor_hours": 2})
    _tech_report(seeded, "Dana", ReportStatus.in_review, {"labor_hours": 5})
    assert client.get("/analytics/fleet").json()["total_labor_hours"] == 2.0
    assert client.get("/analytics/fleet", params={"status": "all"}).json()["total_labor_hours"] == 7.0
    assert client.get("/analytics/fleet", params={"status": "in_review"}).json()["total_labor_hours"] == 5.0
    assert client.get("/analytics/fleet", params={"status": "bogus"}).status_code == 422


def test_lab_manager_filter_is_a_case_insensitive_partial_match(client, seeded):
    _tech_report(seeded, "Dana Levi", ReportStatus.finalized, {"labor_hours": 2})
    _tech_report(seeded, "Avi Cohen", ReportStatus.finalized, {"labor_hours": 3})
    assert client.get("/analytics/fleet", params={"technician": "levi"}).json()["total_labor_hours"] == 2.0
    assert client.get("/analytics/fleet", params={"technician": " "}).json()["total_labor_hours"] == 5.0


def test_text_search_filter_narrows_the_analytics_like_the_reports_list(client, seeded):
    _tech_report(seeded, "A", ReportStatus.finalized, {"labor_hours": 2, "fault_description": "replaced the flow cell"})
    _tech_report(seeded, "B", ReportStatus.finalized, {"labor_hours": 3, "fault_description": "swapped the laser"})
    assert client.get("/analytics/fleet", params={"q": "laser"}).json()["total_labor_hours"] == 3.0
    # Search covers finalized reports only, so a draft status leaves nothing.
    assert client.get("/analytics/fleet", params={"q": "laser", "status": "in_review"}).json()["total_labor_hours"] == 0.0
    assert client.get("/analytics/fleet", params={"q": "x"}).status_code == 422


def test_report_counts_per_instrument_and_per_model(client, seeded):
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair, extracted_fields={"labor_hours": 1})
    _make_report(seeded, model="FACSAria III", report_type=ReportType.preventive_maintenance, extracted_fields={})
    _make_report(seeded, model="LSRFortessa", report_type=ReportType.repair, extracted_fields={})
    _make_report(seeded, model="LSRFortessa", report_type=ReportType.repair, status=ReportStatus.in_review, extracted_fields={})
    body = client.get("/analytics/fleet").json()
    per_unit = {r["model"]: r["report_count"] for r in body["report_counts_by_instrument"]}
    assert per_unit["FACSAria III"] == 2 and per_unit["LSRFortessa"] == 1  # the draft is not counted
    assert per_unit["CytoFLEX S"] == 0  # every instrument is listed
    per_model = {r["model"]: r for r in body["report_counts_by_model"]}
    assert per_model["FACSAria III"]["report_count"] == 2 and per_model["FACSAria III"]["unit_count"] == 1
    assert [r["report_count"] for r in body["report_counts_by_model"]] == sorted(
        (r["report_count"] for r in body["report_counts_by_model"]), reverse=True
    )
    assert client.get("/analytics/fleet", params={"status": "all"}).json()["report_counts_by_instrument"]
    allrows = {r["model"]: r["report_count"] for r in client.get("/analytics/fleet", params={"status": "all"}).json()["report_counts_by_instrument"]}
    assert allrows["LSRFortessa"] == 2


def test_rows_carry_hours_and_pass_counts_for_the_fleet_list(client, seeded):
    """Each per-instrument, per-model and per-place row says how its repair / preventive
    maintenance reports came out and how many hours they took, so the fleet list beside
    the charts can show a pass rate and an hours bar without another request."""
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair,
                 extracted_fields={"labor_hours": 2, "retest_result": "pass"})
    _make_report(seeded, model="FACSAria III", report_type=ReportType.repair,
                 extracted_fields={"labor_hours": 3, "retest_result": "fail"})
    _make_report(seeded, model="FACSAria III", report_type=ReportType.preventive_maintenance,
                 extracted_fields={"labor_hours": 1})
    _make_report(seeded, model="LSRFortessa", report_type=ReportType.repair,
                 extracted_fields={"labor_hours": 4, "retest_result": "pass"})
    body = client.get("/analytics/fleet").json()

    unit = {r["model"]: r for r in body["report_counts_by_instrument"]}["FACSAria III"]
    assert (unit["pass_count"], unit["fail_count"], unit["other_count"]) == (1, 1, 1)
    assert unit["total_labor_hours"] == 6.0

    model = {r["model"]: r for r in body["report_counts_by_model"]}["FACSAria III"]
    assert (model["pass_count"], model["fail_count"], model["other_count"]) == (1, 1, 1)
    assert model["total_labor_hours"] == 6.0
    # The model record's id is what the page sends back as the model_id filter.
    narrowed = client.get("/analytics/fleet", params={"model_id": model["model_id"]}).json()
    assert [r["model"] for r in narrowed["report_counts_by_model"]] == ["FACSAria III"]

    quiet = {r["model"]: r for r in body["report_counts_by_model"]}["CytoFLEX S"]
    assert (quiet["pass_count"], quiet["fail_count"], quiet["other_count"], quiet["total_labor_hours"]) == (0, 0, 0, 0.0)
