"""Seeds 3 finalized demo reports with real live-Claude extraction results,
so a fresh dev database's Reports screen has more than the one flagship
sample document to show — useful for demos and screenshots.

**Not wired into `app.main`'s lifespan on purpose** — that lifespan also
backs `tests/conftest.py`'s `client` fixture (against `calibration_ledger_test`)
and the Playwright e2e suite's backend (against `calibration_ledger_e2e`),
both of which assert on exact report counts/statuses. Auto-seeding demo rows
there would silently inflate those counts and break assertions that were
never written expecting extra reports to exist. Run this by hand against
your own dev database instead, same as `seed_instruments`/`seed_templates`:

    python -m app.seed_demo_reports

The three reports below are real `classify()`/`extract()` results from a
live Claude run (2026-09-18) against three of the six real BD Care EU Work
Order Service Reports this project validates against (see
`backend/validate_live.py`) — one per instrument, covering both the repair
and preventive_maintenance report types not already exercised by the
original flagship sample (`extraction.py::_SAMPLE_REPAIR_VALUES`). The
values are hardcoded here rather than re-fetched live so seeding is free,
deterministic, and doesn't burn an API call or need a key.

The original scanned PDFs are never committed (`.gitignore`'s
`storage/attachments/**` — they're real third-party service records, kept
out of git the same way any uploaded attachment is). Each seeded report gets
a small hand-generated placeholder PDF instead, so "View original scan"
still opens something real rather than 404ing, with a note explaining why
it isn't the actual scan.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    Attachment,
    ExtractionJob,
    ExtractionJobKind,
    ExtractionJobStatus,
    Instrument,
    Report,
    ReportStatus,
)
from app.services.templates import resolve_template

settings = get_settings()

DEMO_REPORTS = [
    {
        "technician_name": "Demo - FACSAria III repair (WO-01873748)",
        "instrument_model": "FACSAria III",
        "report_type": "repair",
        "classification": {
            "instrument": {"value": "FACSAria III", "confidence": 0.97},
            "report_type": {"value": "repair", "confidence": 0.95},
        },
        "extracted_fields": {
            "fault_description": "Air bubble in bleach line in ARIA III 648282B3 S/N P648282B3003",
            "root_cause": "Cracked connector",
            "work_performed": (
                "Replaced quick connector on the wet cart. Connector was slightly cracked. Checked the "
                "system while priming few times to verify proper operation. Bleach filter is full with "
                "Facs Clean fluid. System is ready to use."
            ),
            "components_replaced": [
                {"qty": 1, "part_name": "Face Seal 1/4-28 PMCD12 Panel Mt Fm", "part_number": "641922"}
            ],
            "labor_hours": 3,
            "fault_category": "fluidics",
            "retest_result": "pass",
        },
        "field_confidences": {
            "fault_description": 0.9,
            "root_cause": 0.9,
            "work_performed": 0.9,
            "components_replaced": 0.85,
            "labor_hours": 0.9,
            "fault_category": 0.8,
            "retest_result": 0.6,
        },
    },
    {
        "technician_name": "Demo - LSRFortessa preventive maintenance (WO-04482967)",
        "instrument_model": "LSRFortessa",
        "report_type": "preventive_maintenance",
        "classification": {
            "instrument": {"value": "LSRFortessa", "confidence": 0.97},
            "report_type": {"value": "preventive_maintenance", "confidence": 0.96},
        },
        "extracted_fields": {
            "service_description": "Preventive Maintenance",
            "work_performed": (
                "Half-year maintenance was carried out on the BD LSRFortessa instrument according to the "
                "BD LSRFortessa and SORP LSRFortessa Service Manual (Doc No. 647385). This includes the "
                "following activities: Cleaning of the instrument and the FFSS performed. Exchange of "
                "PM-Kit maintenance parts. Fluidic functions and performances checked. Optical components "
                "cleaned and checked. Optical gel checked. Laser performances checked. System pressures "
                "and flow rates checked. FFSS functions checked for correct operation. The integrity of "
                "the buffer containers checked. Final inspection: CS&T Baseline successfully performed. "
                "CS&T Performance Check successfully performed. Laser safety check performed. System "
                "attributes in BD device database checked. Performed HTS PM. The instrument performs "
                "according to the instrument specifications and is ready for use without restrictions."
            ),
            "components_replaced": [
                {"qty": 1, "part_name": "Pm Kit Scan/Sort/Calib/LSR", "part_number": "34363910"},
                {"qty": 1, "part_name": "FACScalibur/LSR II HTS Parts Kit", "part_number": "644788"},
            ],
            "calibrated_tools": [
                {
                    "tool_id": "T-000024",
                    "tool_name": "Digital Multimeter Generic (Any brand) - 210206006",
                    "last_calibration_date": "06/05/2026",
                    "next_calibration_date": "06/05/2027",
                },
                {
                    "tool_id": "T-000031",
                    "tool_name": "Ophir Laser Power Meter Sensor Head - 959756",
                    "last_calibration_date": "18/05/2026",
                    "next_calibration_date": "18/05/2027",
                },
                {
                    "tool_id": "T-000030",
                    "tool_name": "Ophir Laser Power Meter Display - 958865",
                    "last_calibration_date": "13/05/2026",
                    "next_calibration_date": "13/05/2027",
                },
                {
                    "tool_id": "T-000024",
                    "tool_name": "Digital Multimeter Generic (Any brand) - 57870375",
                    "last_calibration_date": "17/07/2025",
                    "next_calibration_date": "17/07/2026",
                },
                {
                    "tool_id": "T-4240-003-01",
                    "tool_name": "Pressure Meter - 61202/9",
                    "last_calibration_date": "13/08/2025",
                    "next_calibration_date": "13/08/2026",
                },
            ],
            "labor_hours": 3.75,
            "verification_result": "pass",
        },
        "field_confidences": {
            "service_description": 0.9,
            "work_performed": 0.9,
            "components_replaced": 0.9,
            "calibrated_tools": 0.9,
            "labor_hours": 0.9,
            "verification_result": 0.6,
        },
    },
    {
        "technician_name": "Demo - FACSDiscover S8 preventive maintenance (WO-04271950)",
        "instrument_model": "FACSDiscover S8",
        "report_type": "preventive_maintenance",
        "classification": {
            "instrument": {"value": "FACSDiscover S8", "confidence": 0.97},
            "report_type": {"value": "preventive_maintenance", "confidence": 0.95},
        },
        "extracted_fields": {
            "service_description": "11 Month Recurring",
            "work_performed": (
                "Replaced all parts from the kit. FlowCell regel was not done because new FlowCell was "
                "installed 3 months ago. Did optical cleaning and alignment. CS&T passed. Image "
                "calibration passed. Accudrop test passed. System is working properly under BD "
                "specifications and ready for use."
            ),
            "components_replaced": [{"qty": 1, "part_name": "S8 PM kit", "part_number": "667009"}],
            "calibrated_tools": [
                {
                    "tool_id": "T-000030",
                    "tool_name": "Ophir Laser Power Meter Display - 958864",
                    "last_calibration_date": "11/17/2025",
                    "next_calibration_date": "11/17/2026",
                },
                {
                    "tool_id": "T-4240-003-01",
                    "tool_name": "Pressure Meter - 41645/4-24",
                    "last_calibration_date": "03/24/2025",
                    "next_calibration_date": "03/24/2026",
                },
                {
                    "tool_id": "T-000024",
                    "tool_name": "Digital Multimeter Generic (Any brand) - 48910623",
                    "last_calibration_date": "02/03/2025",
                    "next_calibration_date": "02/03/2027",
                },
                {
                    "tool_id": "T-000031",
                    "tool_name": "Ophir Laser Power Meter Sensor Head - 959757",
                    "last_calibration_date": "11/17/2025",
                    "next_calibration_date": "11/17/2026",
                },
            ],
            "labor_hours": 6.25,
            "verification_result": "pass",
        },
        "field_confidences": {
            "service_description": 0.75,
            "work_performed": 0.9,
            "components_replaced": 0.85,
            "calibrated_tools": 0.9,
            "labor_hours": 0.9,
            "verification_result": 0.8,
        },
    },
]


def _make_placeholder_pdf(lines: list[str]) -> bytes:
    """Hand-rolled minimal single-page PDF — no extra dependency for
    something this small. Just enough structure (catalog, one page, one
    Helvetica text stream, a byte-accurate xref table) for any PDF viewer to
    open it cleanly; verified against `pdftotext` while writing this."""
    text_ops = ["BT", "/F1 12 Tf", "50 740 Td", "14 TL"]
    for i, line in enumerate(lines):
        # PDF's simple string literals are Latin-1 — replace anything outside
        # that range (smart punctuation, etc.) rather than letting a stray
        # character blow up the whole seed run.
        ascii_line = line.encode("latin-1", errors="replace").decode("latin-1")
        escaped = ascii_line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        text_ops.append(f"({escaped}) Tj" if i == 0 else f"T* ({escaped}) Tj")
    text_ops.append("ET")
    stream = "\n".join(text_ops).encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]  # object 0 is the free-list head, never used
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode()
    out += b"startxref\n" + f"{xref_offset}\n".encode() + b"%%EOF"
    return bytes(out)


def seed(db: Session) -> list[Report]:
    created = []
    for spec in DEMO_REPORTS:
        existing = db.query(Report).filter(Report.technician_name == spec["technician_name"]).one_or_none()
        if existing:
            created.append(existing)
            continue

        instrument = db.query(Instrument).filter(Instrument.model == spec["instrument_model"]).one_or_none()
        if instrument is None:
            # seed_instruments hasn't run yet — nothing to attach this demo
            # report to, so skip it rather than creating an orphaned report.
            continue
        template = resolve_template(
            db, instrument_type="facs", report_type=spec["report_type"], model=spec["instrument_model"]
        )
        if template is None:
            continue

        now = datetime.now(timezone.utc)
        report = Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=ReportStatus.finalized,
            extracted_fields=spec["extracted_fields"],
            technician_name=spec["technician_name"],
            finalized_at=now,
        )
        db.add(report)
        db.flush()  # need report.id for the attachment path below

        pdf_bytes = _make_placeholder_pdf(
            [
                "Demo seed data",
                "",
                f"This is a placeholder for the real scan behind {spec['technician_name']!r}.",
                "The original document is never committed to git (see .gitignore's",
                "storage/attachments/** rule — it's a real third-party service record).",
                "",
                "The extracted_fields/field_confidences on this report are the real",
                "output of a live Claude call against that document — see",
                "backend/app/seed_demo_reports.py for the exact values and provenance.",
            ]
        )
        attachment_dir = settings.attachment_storage_path / str(report.id)
        attachment_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = attachment_dir / "demo_seed_placeholder.pdf"
        pdf_path.write_bytes(pdf_bytes)

        attachment = Attachment(
            report_id=report.id,
            file_path=str(pdf_path),
            file_type="application/pdf",
            page_count=1,
        )
        db.add(attachment)
        db.flush()

        db.add(
            ExtractionJob(
                attachment_id=attachment.id,
                kind=ExtractionJobKind.classify,
                status=ExtractionJobStatus.succeeded,
                classification=spec["classification"],
                started_at=now,
                completed_at=now,
            )
        )
        db.add(
            ExtractionJob(
                attachment_id=attachment.id,
                kind=ExtractionJobKind.extract,
                status=ExtractionJobStatus.succeeded,
                field_confidences=spec["field_confidences"],
                started_at=now,
                completed_at=now,
            )
        )
        created.append(report)

    db.commit()
    for row in created:
        db.refresh(row)
    return created


if __name__ == "__main__":
    with SessionLocal() as session:
        rows = seed(session)
        print(f"Seeded/updated {len(rows)} demo reports:")
        for row in rows:
            print(f"  - {row.technician_name}")
