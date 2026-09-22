"""Seeds 5 finalized calibration reports for the FACSAria III, spaced two
months apart, so the instrument detail page's trend chart has a realistic,
multi-point line to show in a demo instead of the "only one report has
recorded this so far" fallback.

**Not wired into `app.main`'s lifespan**, same reasoning as
`seed_demo_reports.py`: that lifespan also backs the test-suite databases,
which assert on exact report counts. Run this by hand against your own dev
database before a demo:

    python -m app.seed_trend_demo

Uses `baseline_cv_percent` (a `number[detector]` field — three detectors, so
the chart shows a real multi-series legend) and `fluidics_pressure_psi` (a
flat `number` field, for the single-series case) from the calibration
template seeded by `seed_templates.py`. The values drift upward slightly
report over report — detector 2 crosses the ">5% flag" note from the
template's own field notes by the last point — so the chart has a visible
trend to point at rather than a flat line. Synthetic, not from a real
document (unlike `seed_demo_reports.py`'s three reports); safe to invent
because this is presentation data, not something anyone will read as a real
service record.

Idempotent the same way the other seed_* scripts are: keyed on
`technician_name`, so re-running this after it already ran is a no-op rather
than a pile of duplicate reports.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    Attachment,
    ExtractionJobKind,
    ExtractionJobStatus,
    ExtractionJob,
    Instrument,
    Report,
    ReportStatus,
)
from app.services.templates import resolve_template

settings = get_settings()

INSTRUMENT_MODEL = "FACSAria III"

# (report_date, {detector: baseline_cv_percent}, fluidics_pressure_psi)
TREND_POINTS: list[tuple[date, dict[str, float], float]] = [
    (date(2026, 1, 12), {"detector_1": 2.1, "detector_2": 3.0, "detector_3": 1.4}, 4.9),
    (date(2026, 3, 14), {"detector_1": 2.3, "detector_2": 3.6, "detector_3": 1.5}, 5.0),
    (date(2026, 5, 9), {"detector_1": 2.6, "detector_2": 4.2, "detector_3": 1.6}, 5.1),
    (date(2026, 7, 11), {"detector_1": 2.9, "detector_2": 4.9, "detector_3": 1.7}, 5.2),
    (date(2026, 9, 8), {"detector_1": 3.1, "detector_2": 5.4, "detector_3": 1.8}, 5.4),
]


def _make_placeholder_pdf(lines: list[str]) -> bytes:
    """Same minimal single-page PDF builder as `seed_demo_reports.py` —
    duplicated rather than imported so this script has no dependency on that
    one and can be run/deleted independently."""
    text_ops = ["BT", "/F1 12 Tf", "50 740 Td", "14 TL"]
    for i, line in enumerate(lines):
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
    offsets = [0]
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
    instrument = db.query(Instrument).filter(Instrument.model == INSTRUMENT_MODEL).one_or_none()
    if instrument is None:
        # seed_instruments hasn't run yet — nothing to attach these to.
        return []

    template = resolve_template(db, instrument_type="facs", report_type="calibration", model=INSTRUMENT_MODEL)
    if template is None:
        # seed_templates hasn't run yet.
        return []

    created = []
    for report_date, detector_values, pressure in TREND_POINTS:
        technician_name = f"Demo - FACSAria III calibration ({report_date.isoformat()})"
        existing = db.query(Report).filter(Report.technician_name == technician_name).one_or_none()
        if existing:
            created.append(existing)
            continue

        now = datetime.now(timezone.utc)
        extracted_fields = {
            "baseline_cv_percent": detector_values,
            "fluidics_pressure_psi": pressure,
            "compensation_matrix_updated": True,
            "cst_beads_lot": "CS&T-2026-DEMO",
        }
        field_confidences = {
            "baseline_cv_percent": 0.92,
            "fluidics_pressure_psi": 0.95,
            "compensation_matrix_updated": 0.9,
            "cst_beads_lot": 0.88,
        }

        report = Report(
            instrument_id=instrument.id,
            template_id=template.id,
            status=ReportStatus.finalized,
            extracted_fields=extracted_fields,
            technician_name=technician_name,
            report_date=report_date,
            finalized_at=now,
        )
        db.add(report)
        db.flush()

        pdf_bytes = _make_placeholder_pdf(
            [
                "Demo seed data - trend chart calibration series",
                "",
                f"Placeholder for a {report_date.isoformat()} FACSAria III calibration report.",
                "Synthetic values, generated to give the instrument detail page's trend",
                "chart a realistic multi-point series ahead of a demo. See",
                "backend/app/seed_trend_demo.py for the exact values and why.",
            ]
        )
        attachment_dir = settings.attachment_storage_path / str(report.id)
        attachment_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = attachment_dir / "trend_seed_placeholder.pdf"
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
                classification={
                    "instrument": {"value": INSTRUMENT_MODEL, "confidence": 0.97},
                    "report_type": {"value": "calibration", "confidence": 0.95},
                },
                started_at=now,
                completed_at=now,
            )
        )
        db.add(
            ExtractionJob(
                attachment_id=attachment.id,
                kind=ExtractionJobKind.extract,
                status=ExtractionJobStatus.succeeded,
                field_confidences=field_confidences,
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
        print(f"Seeded/updated {len(rows)} calibration reports for {INSTRUMENT_MODEL}:")
        for row in rows:
            print(f"  - {row.technician_name}")
