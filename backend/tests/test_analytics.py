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
    # calibration never carries labor_hours (seed_templates.py) — even if a
    # stray value showed up here, it must not be counted, since nothing
    # downstream should ever see a calibration report contribute hours.
    _make_report(
        seeded,
        model="FACSDiscover S8",
        report_type=ReportType.calibration,
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
