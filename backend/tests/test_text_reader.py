"""Reading a service report with no API key (services/text_reader.py), and
what that makes possible: classification from the document's own text and
duplicate detection at upload.

The PDFs here are synthetic, built with reportlab, but laid out the way real
BD reports extract with pypdf — including the quirks that broke the first
version of the parser: a label glued to its value ("Work Order Task CodeT113"),
the previous label glued to the product line ("N/A665158 - ..."), a
configuration string sitting beside a "Serial/Lot Number" label, a part
number that looks like a task code, and a fillable form whose content lives in
form fields rather than page text.
"""
from __future__ import annotations

import io

import pytest
from reportlab.pdfgen import canvas

from app.services.text_reader import extract_text, read_identifiers, read_work_order

MODELS = ["FACSAria III", "LSRFortessa", "FACSDiscover S8"]


def make_pdf(lines: list[str], *, fields: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf)
    y = 800
    for line in lines:
        pdf.drawString(40, y, line)
        y -= 16
    for i, (name, value) in enumerate((fields or {}).items()):
        pdf.acroForm.textfield(name=name, value=value, x=40, y=300 - i * 30, width=300, height=20, borderStyle="solid")
    pdf.save()
    return buf.getvalue()


def service_report(
    *,
    work_order="WO-90000001",
    task="T113 Repair / Troubleshooting Visit",
    product="647794E6 - LSRFortessa SO",
    serial="R647794E6092",
) -> list[str]:
    return [
        "Service Report",
        f"CASE NUMBER : 02320568      WORK ORDER NUMBER: {work_order}",
        "ACCOUNT   INSTRUMENT LOCATION   SYSTEM   INSTALLED PRODUCT",
        f"N/A{product}",  # the previous label runs straight into the line
        "B50R40V50YG50 6V",  # a configuration string, not a serial
        "Serial/Lot Number:",
        serial,
        "WORK ORDER DETAILS",
        f"Work Order Task Code{task}",  # label glued to its value
        "Subject: S/N R9999999999999 mentioned in free text",
        "PARTS USED",
        "640127 - Pressure Gauge Digital - T-000030",  # parts look like products and task codes
    ]


# ---------- unit: extract_text ----------


@pytest.mark.parametrize("data", [b"", b"not a pdf", b"%PDF-1.4 truncated", b"\x89PNG\r\n\x1a\n" + b"0" * 50])
def test_no_text_for_anything_that_is_not_a_readable_pdf(data):
    assert extract_text(data) == ""


def test_extract_text_reads_a_text_pdf():
    assert "WORK ORDER NUMBER: WO-90000001" in extract_text(make_pdf(service_report()))


def test_extract_text_includes_the_values_of_fillable_form_fields():
    pdf = make_pdf(["Product Intervention Report Form"], fields={"instrument": "648282B3 - ARIA III ACDU 6B/3R/3V"})
    assert "648282B3 - ARIA III ACDU 6B/3R/3V" in extract_text(pdf)


def test_extract_text_stops_after_the_first_pages():
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf)
    for n in range(1, 6):
        pdf.drawString(40, 800, f"page {n} marker")
        pdf.showPage()
    pdf.save()
    text = extract_text(buf.getvalue(), max_pages=2)
    assert "page 2 marker" in text and "page 3 marker" not in text


# ---------- unit: read_identifiers ----------


def test_a_service_report_is_read_completely():
    read = read_identifiers(extract_text(make_pdf(service_report())), MODELS)
    assert (read.model, read.serial, read.task_code, read.work_order_number) == (
        "LSRFortessa", "R647794E6092", "T113", "WO-90000001",
    )
    assert read.product_code == "647794E6" and read.recognised


def test_the_serial_is_the_token_that_contains_the_product_code_not_the_config_string_or_free_text():
    # Free text names a look-alike serial after the real one; the first token
    # after the Installed Product line wins.
    read = read_identifiers(
        extract_text(make_pdf(service_report(product="665158 - FACSDiscover S8", serial="MP6651580000099"))), MODELS
    )
    assert (read.model, read.serial) == ("FACSDiscover S8", "MP6651580000099")


@pytest.mark.parametrize(
    ("product", "model"),
    [
        ("647794E6 - LSRFortessa SO", "LSRFortessa"),
        ("648282B3 - ARIA III ACDU 6B/3R/3V", "FACSAria III"),  # BD drops the FACS prefix
        ("665158 - FACSDiscover S8", "FACSDiscover S8"),
    ],
)
def test_models_are_matched_the_way_bd_prints_them(product, model):
    assert read_identifiers(f"{product}\nSerial/Lot Number:", MODELS).model == model


def test_the_longest_model_name_wins_over_a_prefix_of_it():
    assert read_identifiers("648282B3 - ARIA III ACDU", ["FACSAria II", "FACSAria III"]).model == "FACSAria III"


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Work Order Task CodeT113 Repair / Troubleshooting", "T113"),
        ("Work Order Task Code T111 Preventive Maintenance", "T111"),
        ("T107 Install: Options, Upgrades, S/W", "T107"),  # a form's dropdown value
        ("Work Order Task Code", None),
        ("part T-000030 and T4240 and ref T113", None),  # no label, no description: not a task code
    ],
)
def test_task_codes_need_a_label_or_a_description_beside_them(text, code):
    assert read_identifiers(text, MODELS).task_code == code


def test_a_product_line_for_a_part_is_not_an_instrument():
    read = read_identifiers("640127 - Pressure Gauge Digital\n667009 - S8 PM kit", MODELS)
    assert read.model is None and read.serial is None


def test_a_bd_document_for_an_unknown_model_is_recognised_but_has_no_model():
    read = read_identifiers("WORK ORDER NUMBER: WO-90000002\n999999 - ACME Cytometer 9000", MODELS)
    assert read.model is None and read.work_order_number == "WO-90000002" and read.recognised


def test_text_that_is_not_a_service_document_is_not_recognised():
    assert not read_identifiers("Quarterly invoice, page 1 of 3", MODELS).recognised


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("WORK ORDER NUMBER: WO-03424229", "WO-03424229"),
        ("WORK ORDER NUMBER:WO-03424229", "WO-03424229"),
        ("see wo-0342 and WO-12345678 in notes", "WO-12345678"),
        ("no number here", None),
        ("SWO-12345678", None),
    ],
)
def test_read_work_order(text, expected):
    assert read_work_order(text) == expected


# ---------- integration: no API key (stub mode) ----------

PLACEHOLDER = b"%PDF-1.4 placeholder with no text"


def _new_report(client) -> str:
    return client.post("/reports", json={"technician_name": "R. Tester"}).json()["id"]


def _upload(client, data: bytes, name="scan.pdf", report_id=None):
    resp = client.post(
        f"/reports/{report_id or _new_report(client)}/attachments", files={"file": (name, data, "application/pdf")}
    )
    assert resp.status_code == 201
    return resp.json()


def _classify(client, run_worker, attachment_id):
    job = client.post(f"/attachments/{attachment_id}/classify").json()
    run_worker()
    done = client.get(f"/extraction-jobs/{job['id']}").json()
    assert done["status"] == "succeeded"
    return done["classification"]


def test_a_real_looking_report_is_classified_from_its_own_text(client, run_worker):
    attachment = _upload(client, make_pdf(service_report()))
    result = _classify(client, run_worker, attachment["id"])

    assert result["reader"] == "text_layer"
    assert result["instrument"] == {"value": "LSRFortessa", "confidence": 0.95}
    assert result["report_type"] == {"value": "repair", "confidence": 0.95}
    assert result["report_type_source"] == "task_code"
    assert result["instrument_serial"]["value"] == "R647794E6092" and result["serial_match"] == "matched"
    assert result["work_order_number"] == "WO-90000001"
    # Confident on everything, so straight through, with no model involved.
    assert result["resolved_template_id"] and result["resolved_instrument_id"]


def test_each_task_code_resolves_to_its_template(client, run_worker):
    for n, (task, expected) in enumerate(
        [
            ("T111 Preventive Maintenance", "preventive_maintenance"),
            ("T107 Install: Options, Upgrades, S/W", "installation_upgrade"),
        ]
    ):
        pdf = make_pdf(service_report(task=task, work_order=f"WO-9100000{n}"))
        result = _classify(client, run_worker, _upload(client, pdf)["id"])
        assert result["report_type"]["value"] == expected and result["resolved_template_id"], task


def test_an_unknown_task_code_goes_to_the_manual_pick_instead_of_guessing(client, run_worker):
    result = _classify(client, run_worker, _upload(client, make_pdf(service_report(task="T999 Something New")))["id"])
    assert result["report_type_source"] == "none" and result["report_type"]["confidence"] == 0.0
    assert result["resolved_template_id"] is None
    # What was read is still kept for the technician and for duplicate detection.
    assert result["instrument"]["value"] == "LSRFortessa" and result["work_order_number"] == "WO-90000001"


def test_an_unknown_instrument_model_goes_to_the_manual_pick(client, run_worker):
    pdf = make_pdf(service_report(product="999999 - ACME Cytometer 9000", serial="X9999990001"))
    result = _classify(client, run_worker, _upload(client, pdf)["id"])
    assert result["instrument"]["confidence"] == 0.0 and result["resolved_template_id"] is None


def test_a_serial_not_in_the_fleet_is_reported_not_guessed(client, run_worker):
    pdf = make_pdf(service_report(product="665158 - FACSDiscover S8", serial="MP6651580000099"))
    result = _classify(client, run_worker, _upload(client, pdf)["id"])
    assert result["instrument_serial"]["value"] == "MP6651580000099" and result["serial_match"] == "not_found"
    # Only one S8 in the fleet, so it is still the model's only unit.
    assert result["resolved_instrument_id"] is not None


def test_a_file_with_no_text_still_gets_the_demo_answer(client, run_worker):
    result = _classify(client, run_worker, _upload(client, PLACEHOLDER)["id"])
    assert result["reader"] == "stub"


def test_an_image_scan_has_no_text_to_read_and_is_not_an_error(client, run_worker):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 40
    resp = client.post(f"/reports/{_new_report(client)}/attachments", files={"file": ("scan.png", png, "image/png")})
    assert resp.status_code == 201 and resp.json()["duplicate_report_ids"] == []
    assert _classify(client, run_worker, resp.json()["id"])["reader"] == "stub"


# ---------- integration: duplicates, with no API key and before classifying ----------


def test_the_same_visit_scanned_again_is_flagged_at_upload_by_its_work_order(client):
    first_report = _new_report(client)
    _upload(client, make_pdf(service_report()), "first.pdf", first_report)

    # Different bytes (an extra line), same work order: only the text says so.
    rescan = _upload(client, make_pdf(service_report() + ["scanned twice"]), "rescan.pdf")
    assert rescan["duplicate_report_ids"] == [first_report]


def test_the_same_file_is_flagged_at_upload_by_its_bytes(client):
    first_report = _new_report(client)
    pdf = make_pdf(service_report())
    _upload(client, pdf, "first.pdf", first_report)
    assert _upload(client, pdf, "copy.pdf")["duplicate_report_ids"] == [first_report]


def test_a_different_visit_to_the_same_instrument_is_not_a_duplicate(client):
    _upload(client, make_pdf(service_report(work_order="WO-90000001")), "visit-one.pdf")
    other = _upload(client, make_pdf(service_report(work_order="WO-90000002")), "visit-two.pdf")
    assert other["duplicate_report_ids"] == []


def test_a_form_with_no_work_order_is_never_matched_by_one(client):
    form = make_pdf(["Product Intervention Report Form"], fields={"instrument": "648282B3 - ARIA III ACDU 6B/3R/3V"})
    _upload(client, make_pdf(service_report()), "report.pdf")
    assert _upload(client, form, "form.pdf")["duplicate_report_ids"] == []


def test_the_work_order_is_stored_without_classifying(client, db_session):
    from app import models

    attachment = _upload(client, make_pdf(service_report()))
    assert db_session.get(models.Attachment, attachment["id"]).work_order_number == "90000001"
