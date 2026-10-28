"""Reading a template's fields from a service report's own text, no model
(services/text_extraction.py, the STUB_EXTRACT_FROM_TEXT option of stub mode, on by default).

The PDFs are synthetic, built with reportlab, and laid out the way the two real
BD Care Work Order forms extract with pypdf: the label printed after its value
("...nozzlesSubject"), a labor row wrapped onto a second line, the part-in
location on its own line in one form and no location in the other, 24-hour
times and day-first dates in one, 12-hour times and month-first dates in the
other. No customer name, contact or sign-off appears in them, and the tests
that touch the privacy rule check that none reaches a field.
"""
from __future__ import annotations

import io
from datetime import date
from types import SimpleNamespace

import pytest
from reportlab.pdfgen import canvas

from app import seed_templates
from app.services import extraction
from app.services.errors import ExtractionError
from app.services.text_extraction import date_order, extract_from_text, text_extract


def make_pdf(lines: list[str]) -> bytes:
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf)
    y = 800
    for line in lines:
        pdf.drawString(30, y, line)
        y -= 14
    pdf.save()
    return buf.getvalue()


REPAIR_LINES = [
    "Service Report",
    "CASE NUMBER : 02000001 WORK ORDER NUMBER: WO-04000001",
    "665158 - ARIA III ACDU",
    "Serial/Lot Number:",
    "P648282B3003",
    "Work Order Task Code T113 Repair / Troubleshooting",
    "SERVICE REQUESTED / REPORTED SYMPTOM",
    ": Stream is unstable - ARIA III S/N P648282B3003Subject",
    ": Stream is unstable - ARIA III S/N P648282B3003Description",
    "CAUSE",
    "Stream is moving down and fsc ssc position shifts",
    "WORK PERFORMED / SOLUTION COMMENTS",
    "November 10, it took a while to identify the issue.",
    "I replaced the sheath regulator. By Someone on 10/11/2025 is part of the narrative text.",
    "System is working properly and ready to use",
    "PARTS USED",
    "Part In Part Number Line Qty",
    "644651 - Sample/Sheath Regulator Assembly",
    "V-Pos 644651 1",
    "LABOR",
    "Start Date And Time End Date And Time Total Hours Worked Total Rounded Hours",
    "10/11/2025 10:44 10/11/2025 17:09 0 day(s) 6 hour(s) 25 minute(s) 6.5",
    "12/11/2025 09:47 12/11/2025 21:40 0 day(s) 11 hour(s) 53",
    "minute(s)",
    "12",
    "18/11/2025 10:03 18/11/2025 15:55 0 day(s) 5 hour(s) 52 minute(s) 5.75",
    "TRAVEL",
    "Start Date And Time End Date And Time Total Hours Work Total Rounded Hours",
    "10/11/2025 09:02 10/11/2025 10:44 0 day(s) 1 hour(s) 42 minute(s) 1.75",
    "EXPENSE",
    "CALIBRATED TOOLS",
    "T-000031 - Ophir Laser Power Meter Sensor Head - 643260 25/02/2025 25/02/2026",
    "Date: 18/11/2025 17:24",
]

PM_LINES = [
    "Service Report",
    "CASE NUMBER : 02000002 WORK ORDER NUMBER: WO-04000002",
    "665158 - FACSDiscover S8",
    "Serial/Lot Number:",
    "MP6651580000057",
    "Work Order Task Code T111 Preventive Maintenance",
    "Service Contract Start / Service Contract End 03/17/2025 - 03/16/2026",
    "SERVICE REQUESTED / REPORTED SYMPTOM",
    ": 11 Month Recurring / SMX0457374Subject",
    ": 11 Month Recurring / SMX0457374Description",
    "CAUSE",
    "WORK PERFORMED / SOLUTION COMMENTS",
    "Replaced all parts from the kit.",
    "Did optical cleaning and alignment.",
    "PARTS USED",
    "Part In Part Number Line Qty",
    "667009 - S8 PM kit 667009 1",
    "LABOR",
    "Start Date And Time End Date And Time Total Hours Worked Total Rounded Hours",
    "02/10/2026 10:39 AM 02/10/2026 4:55 PM 0 day(s) 6 hour(s) 16 minute(s) 6.25",
    "TRAVEL",
    "Start Date And Time End Date And Time Total Hours Work Total Rounded Hours",
    "02/10/2026 8:37 AM 02/10/2026 10:39 AM 0 day(s) 2 hour(s) 2 minute(s) 2",
    "EXPENSE",
    "CALIBRATED TOOLS",
    "T-000030 - Ophir Laser Power Meter Display - 958864 11/17/2025 11/17/2026",
    "T-4240-003-01 - Pressure Meter - 41645/4-24 03/24/2025 03/24/2026",
    "Date: 02/10/2026 4:57 PM",
]


def fields_of(name: str) -> list[dict]:
    return {
        "repair": seed_templates.REPAIR_FIELDS,
        "pm": seed_templates.PM_FIELDS,
        "install": seed_templates.INSTALL_UPGRADE_FIELDS,
    }[name]


def read(lines: list[str], template: str):
    extracted, confidences, report_date = text_extract(make_pdf(lines), fields_of(template))
    return extracted, confidences, report_date


# ---------- the day-first repair layout ----------


def test_a_repair_report_is_read_field_by_field():
    values, conf, visit = read(REPAIR_LINES, "repair")

    # The Subject and Description are the same line, so it appears once, and the
    # serial the technician typed into it is left out.
    assert values["fault_description"] == "Stream is unstable"
    assert values["root_cause"] == "Stream is moving down and fsc ssc position shifts"
    assert values["work_performed"].startswith("November 10, it took a while")
    assert values["work_performed"].endswith("ready to use")
    assert values["components_replaced"] == [
        {"part_name": "Sample/Sheath Regulator Assembly", "part_number": "644651", "qty": 1}
    ]
    # Rounded hours of the labor rows, one of which wraps onto three lines; the
    # travel table is not counted.
    assert values["labor_hours"] == 6.5 + 12 + 5.75
    # The last labor end date, read day-first because 18/11/2025 can be nothing else.
    assert visit == date(2025, 11, 18)
    assert conf["report_date"] == 0.9


def test_fields_that_are_not_on_the_form_stay_empty_at_zero_confidence():
    values, conf, _ = read(REPAIR_LINES, "repair")

    # Lab-manager fields: nothing on the form says them, so nothing is invented.
    assert values["fault_category"] is None and conf["fault_category"] == 0.0
    assert values["retest_result"] is None and conf["retest_result"] == 0.0


def test_every_read_field_carries_a_confidence_and_nothing_else_does():
    _, conf, _ = read(REPAIR_LINES, "repair")
    assert set(conf) == {f["name"] for f in seed_templates.REPAIR_FIELDS} | {"report_date"}
    assert conf["fault_description"] == 0.9 and conf["labor_hours"] == 0.8


# ---------- the month-first preventive maintenance layout ----------


def test_a_pm_report_with_12_hour_times_and_month_first_dates_is_read():
    values, conf, visit = read(PM_LINES, "pm")

    assert values["service_description"] == "11 Month Recurring"  # the contract number is dropped
    assert values["work_performed"] == "Replaced all parts from the kit.\nDid optical cleaning and alignment."
    # "kit" is the end of the part's name, not a part-in location.
    assert values["components_replaced"] == [{"part_name": "S8 PM kit", "part_number": "667009", "qty": 1}]
    assert values["labor_hours"] == 6.25
    # 03/17/2025 on the form settles month-first, so 02/10/2026 is 10 February.
    assert visit == date(2026, 2, 10)
    assert values["calibrated_tools"] == [
        {
            "tool_id": "T-000030",
            "tool_name": "Ophir Laser Power Meter Display",
            "last_calibration_date": "2025-11-17",
            "next_calibration_date": "2026-11-17",
        },
        {
            "tool_id": "T-4240-003-01",
            "tool_name": "Pressure Meter",
            "last_calibration_date": "2025-03-24",
            "next_calibration_date": "2026-03-24",
        },
    ]
    assert values["verification_result"] is None and conf["verification_result"] == 0.0


def test_an_empty_cause_section_is_empty_and_flagged_not_invented():
    values, conf, _ = read(PM_LINES, "repair")
    assert values["root_cause"] == ""
    assert conf["root_cause"] == 0.35  # below the 0.7 review threshold: a person looks at it


def test_the_installation_template_reads_parts_used_and_service_description():
    values, _, _ = read(PM_LINES, "install")
    assert values["service_description"] == "11 Month Recurring"
    assert values["parts_used"] == [{"part_name": "S8 PM kit", "part_number": "667009", "qty": 1}]


# ---------- dates ----------


@pytest.mark.parametrize(
    "text, expected",
    [
        ("18/11/2025", "day-first"),
        ("03/17/2025", "month-first"),
        ("02/10/2026 and 18/11/2025", "day-first"),
        ("02/10/2026", None),  # nothing settles it
    ],
)
def test_date_order_comes_from_any_date_that_settles_it(text, expected):
    assert date_order(text) == expected


def test_a_form_that_does_not_settle_the_date_order_gets_a_low_date_confidence():
    lines = [l for l in PM_LINES if "03/17/2025" not in l and "11/17/2025" not in l and "03/24/2025" not in l]
    lines = [l for l in lines if not l.startswith("T-")]
    _, conf, visit = read(lines, "pm")
    assert visit == date(2026, 10, 2)  # a best reading is still given: BD EU forms are mostly day-first
    assert conf["report_date"] == 0.5


def test_an_implausible_visit_date_is_dropped():
    lines = [l.replace("10/11/2025", "10/11/1850").replace("12/11/2025", "12/11/1850").replace("18/11/2025", "18/11/1850") for l in REPAIR_LINES]
    _, conf, visit = read(lines, "repair")
    assert visit is None and conf["report_date"] == 0.0


# ---------- gaps and refusals ----------


def test_a_form_without_a_labor_table_leaves_hours_and_date_empty():
    lines = REPAIR_LINES[: REPAIR_LINES.index("LABOR")]
    values, conf, visit = read(lines, "repair")
    assert values["labor_hours"] is None and conf["labor_hours"] == 0.0
    assert visit is None and conf["report_date"] == 0.0
    assert values["work_performed"].startswith("November 10")  # the rest is still read


def test_a_field_with_a_known_name_but_another_type_is_left_empty():
    fields = [{"name": "labor_hours", "type": "text"}, {"name": "work_performed", "type": "number"}]
    values, conf, _ = extract_from_text("\n".join(REPAIR_LINES), fields)
    assert values == {"labor_hours": "", "work_performed": None}
    assert conf == {"labor_hours": 0.0, "work_performed": 0.0, "report_date": 0.9}


def test_unknown_custom_fields_get_the_types_empty_value():
    fields = [
        {"name": "x_text", "type": "text"},
        {"name": "x_list", "type": "object[]", "item_schema": []},
        {"name": "x_flag", "type": "boolean"},
        {"name": "x_number", "type": "number"},
    ]
    values, _, _ = extract_from_text("\n".join(REPAIR_LINES), fields)
    assert values == {"x_text": "", "x_list": [], "x_flag": None, "x_number": None}


@pytest.mark.parametrize("data", [make_pdf([]), b"%PDF-1.4 placeholder with no text", b"\x89PNG\r\n\x1a\n not text"])
def test_a_file_with_no_text_is_refused_with_a_message_about_the_key(data):
    with pytest.raises(ExtractionError, match="API key"):
        text_extract(data, seed_templates.REPAIR_FIELDS)


# ---------- the option in extract() ----------


def _attachment(tmp_path, data: bytes):
    path = tmp_path / "scan.pdf"
    path.write_bytes(data)
    return SimpleNamespace(file_path=str(path))


def _template(fields):
    return SimpleNamespace(field_schema={"fields": fields})


def test_the_option_is_on_by_default(monkeypatch):
    # conftest sets STUB_EXTRACT_FROM_TEXT=false for the rest of the suite; the
    # default itself is what a deployment without the variable gets.
    from app.config import Settings

    monkeypatch.delenv("STUB_EXTRACT_FROM_TEXT", raising=False)
    assert Settings(_env_file=None).stub_extract_from_text is True


def test_the_environment_can_turn_it_off(monkeypatch):
    from app.config import Settings

    monkeypatch.setenv("STUB_EXTRACT_FROM_TEXT", "false")
    assert Settings(_env_file=None).stub_extract_from_text is False


def test_with_the_option_off_stub_mode_still_invents_values(tmp_path, monkeypatch):
    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", False)
    result = extraction.extract(_attachment(tmp_path, make_pdf(REPAIR_LINES)), _template(seed_templates.REPAIR_FIELDS))
    assert result.extracted_fields["fault_description"].startswith("[stub]")


def test_with_the_option_on_stub_mode_reads_the_document(tmp_path, monkeypatch):
    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", True)
    result = extraction.extract(_attachment(tmp_path, make_pdf(REPAIR_LINES)), _template(seed_templates.REPAIR_FIELDS))
    assert result.extracted_fields["fault_description"] == "Stream is unstable"
    assert result.report_date == date(2025, 11, 18)
    assert result.field_confidences["fault_category"] == 0.0


def test_with_the_option_on_an_unreadable_scan_fails_the_extraction(tmp_path, monkeypatch):
    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", True)
    with pytest.raises(ExtractionError, match="API key"):
        extraction.extract(_attachment(tmp_path, b"%PDF-1.4 no text"), _template(seed_templates.REPAIR_FIELDS))


def test_the_live_path_wins_over_the_option(tmp_path, monkeypatch):
    monkeypatch.setattr(extraction.settings, "use_live_claude", True)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", True)
    called = []
    monkeypatch.setattr(extraction, "_live_extract", lambda a, t: called.append(True) or "live")
    assert extraction.extract(_attachment(tmp_path, make_pdf(REPAIR_LINES)), _template([])) == "live"
    assert called


# ---------- end to end through the worker ----------


def test_an_uploaded_pm_report_goes_from_classification_to_real_field_values(client, run_worker, monkeypatch):
    monkeypatch.setattr(extraction.settings, "use_live_claude", False)
    monkeypatch.setattr(extraction.settings, "stub_extract_from_text", True)
    report = client.post("/reports", json={}).json()
    attachment = client.post(
        f"/reports/{report['id']}/attachments",
        files={"file": ("pm.pdf", make_pdf(PM_LINES), "application/pdf")},
    ).json()
    classify = client.post(f"/attachments/{attachment['id']}/classify").json()
    run_worker()
    assert client.get(f"/extraction-jobs/{classify['id']}").json()["status"] == "succeeded"

    extract = client.post(f"/attachments/{attachment['id']}/extract").json()
    run_worker()
    job = client.get(f"/extraction-jobs/{extract['id']}").json()
    assert job["status"] == "succeeded", job
    saved = client.get(f"/reports/{report['id']}").json()
    assert saved["status"] == "extracted"
    assert saved["report_date"] == "2026-02-10"
    assert saved["extracted_fields"]["labor_hours"] == 6.25
    assert saved["extracted_fields"]["service_description"] == "11 Month Recurring"
    # The review screen flags what was not read: confidence 0 is under the threshold.
    assert job["field_confidences"]["verification_result"] == 0.0
