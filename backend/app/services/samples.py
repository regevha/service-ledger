"""The first-run sample (docs/features/first-run-sample/): a demo report a new user can open from the New
report screen to see a service form turned into checked fields, without uploading anything.

Everything here is invented (no real vendor, institution, person or serial) and nothing is read by Claude: the
extraction result is stored below, as a finished extract job, the same shape the worker leaves. The report, its
demo instrument, the demo model record and the demo places carry `is_sample`, which every list, count and
export of real data leaves out. They are created only when the sample is opened, never by a seed or at startup,
and `remove_sample_data` takes all of them away again (the future "start clean" step calls it too).
"""
from __future__ import annotations

import shutil
from datetime import date, datetime, timezone
from io import BytesIO

from reportlab.lib.pagesizes import A4  # type: ignore[import-untyped]
from reportlab.pdfgen import canvas  # type: ignore[import-untyped]
from sqlalchemy.orm import Session

from app import models
from app.config import get_settings
from app.schemas import REPORT_DATE_KEY
from app.services.templates import resolve_template

SAMPLE_INSTITUTION = "Demo institute"
SAMPLE_ROOM = "Demo lab"
SAMPLE_MAKER = "Demo Maker"
SAMPLE_MODEL = "Demo Sorter D1"
SAMPLE_INSTRUMENT_NAME = "Demo cell sorter"
SAMPLE_SERIAL = "DEMO-0001"
SAMPLE_REPORT_DATE = date(2026, 3, 12)
SAMPLE_FILENAME = "sample-service-report.pdf"

# What the reading found. Field names are the generic repair template's own. One value carries a low confidence
# on purpose (under the 0.7 review threshold): the first impression includes a flag, and a real scan is never
# perfect. The review screen also asks for the fault category, which a person fills in on every repair report.
SAMPLE_FIELDS: dict = {
    "fault_description": "Sort stream drifts to the left and the drop delay will not hold after start-up.",
    "root_cause": "Worn nozzle O-ring (the technician's note is hard to read).",
    "work_performed": (
        "Replaced the nozzle O-ring and the sheath filter. Ran the drop delay set-up again and a ten-minute "
        "sort test; the stream stayed stable. System handed back to the lab."
    ),
    "components_replaced": [
        {"part_name": "Nozzle O-ring", "part_number": "DM-4410", "qty": 1},
        {"part_name": "Sheath filter", "part_number": "DM-2207", "qty": 1},
    ],
    "labor_hours": 2.5,
}
SAMPLE_CONFIDENCES: dict = {
    "fault_description": 0.95,
    "root_cause": 0.58,
    "work_performed": 0.93,
    "components_replaced": 0.9,
    "labor_hours": 0.93,
    REPORT_DATE_KEY: 0.96,
}
SAMPLE_CLASSIFICATION: dict = {
    "instrument": {"value": SAMPLE_MODEL, "confidence": 0.99},
    "report_type": {"value": "repair", "confidence": 0.98},
}


class SampleUnavailable(Exception):
    """The sample cannot be made (the generic repair template is missing)."""


def get_sample_report(db: Session) -> models.Report | None:
    return db.query(models.Report).filter(models.Report.is_sample.is_(True)).order_by(models.Report.created_at).first()


def stored_confidences(db: Session, report: models.Report) -> dict:
    """What the reading was sure of for this sample (its extract job's field confidences)."""
    attachment_ids = [a.id for a in report.attachments]
    job = (
        db.query(models.ExtractionJob)
        .filter(
            models.ExtractionJob.attachment_id.in_(attachment_ids),
            models.ExtractionJob.kind == models.ExtractionJobKind.extract,
        )
        .order_by(models.ExtractionJob.completed_at.desc())
        .first()
    )
    return dict(job.field_confidences or {}) if job else {}


def _sample_pdf() -> bytes:
    """A one-page form with the values above, so the scan beside the fields shows what was read."""
    buffer = BytesIO()
    c = canvas.Canvas(buffer, pagesize=A4, invariant=True)
    width, height = A4
    c.setTitle("Sample service report")
    c.setFont("Helvetica-Bold", 18)
    c.drawString(50, height - 60, "SERVICE REPORT")
    c.setFont("Helvetica", 9)
    c.drawString(50, height - 76, "Sample document with invented values. Not a real service record.")
    c.line(50, height - 84, width - 50, height - 84)

    def row(y: float, label: str, value: str) -> None:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(50, y, label)
        c.setFont("Helvetica", 10)
        c.drawString(190, y, value)

    y = height - 110
    for label, value in (
        ("Service date", SAMPLE_REPORT_DATE.strftime("%d %B %Y")),
        ("Instrument", f"{SAMPLE_MAKER} {SAMPLE_MODEL}"),
        ("Serial number", SAMPLE_SERIAL),
        ("Visit type", "Repair"),
    ):
        row(y, label, value)
        y -= 18

    def block(y: float, title: str, text: str) -> float:
        c.setFont("Helvetica-Bold", 10)
        c.drawString(50, y, title)
        c.setFont("Helvetica", 10)
        y -= 15
        words, line = text.split(), ""
        for word in words:
            if c.stringWidth(f"{line} {word}".strip(), "Helvetica", 10) > width - 100:
                c.drawString(50, y, line)
                y -= 13
                line = word
            else:
                line = f"{line} {word}".strip()
        c.drawString(50, y, line)
        return y - 26

    y -= 10
    y = block(y, "Reported problem", str(SAMPLE_FIELDS["fault_description"]))
    y = block(y, "Cause", str(SAMPLE_FIELDS["root_cause"]))
    y = block(y, "Work performed", str(SAMPLE_FIELDS["work_performed"]))

    c.setFont("Helvetica-Bold", 10)
    c.drawString(50, y, "Parts used")
    y -= 15
    c.setFont("Helvetica-Bold", 9)
    for x, head in ((50, "Part"), (250, "Part number"), (400, "Qty")):
        c.drawString(x, y, head)
    c.setFont("Helvetica", 10)
    for part in SAMPLE_FIELDS["components_replaced"]:
        y -= 14
        c.drawString(50, y, str(part["part_name"]))
        c.drawString(250, y, str(part["part_number"]))
        c.drawString(400, y, str(part["qty"]))
    y -= 30
    row(y, "Labor", f"{SAMPLE_FIELDS['labor_hours']} hours")
    c.showPage()
    c.save()
    return buffer.getvalue()


def create_sample(db: Session) -> tuple[models.Report, bool]:
    """The sample report, made now if there is none yet. Returns (report, created)."""
    existing = get_sample_report(db)
    if existing is not None:
        return existing, False
    template = resolve_template(
        db, instrument_type=models.DEFAULT_INSTRUMENT_TYPE_KEY, report_type="repair", model=SAMPLE_MODEL
    )
    if template is None:
        raise SampleUnavailable("The repair report type is not set up, so the sample cannot be opened.")

    institution = models.Place(kind="institution", name=SAMPLE_INSTITUTION, is_sample=True)
    room = models.Place(kind="room", name=SAMPLE_ROOM, parent=institution, is_sample=True)
    # The model record is made here, flagged, so the link that every instrument save makes finds it by name
    # instead of creating an unflagged one.
    model_record = models.InstrumentModel(
        name=SAMPLE_MODEL, instrument_type=models.DEFAULT_INSTRUMENT_TYPE_KEY, is_sample=True
    )
    db.add_all([institution, room, model_record])
    db.flush()
    instrument = models.Instrument(
        name=SAMPLE_INSTRUMENT_NAME,
        instrument_type=models.DEFAULT_INSTRUMENT_TYPE_KEY,
        model=SAMPLE_MODEL,
        model_record=model_record,
        serial_number=SAMPLE_SERIAL,
        place=room,
        is_sample=True,
    )
    db.add(instrument)
    db.flush()

    now = datetime.now(timezone.utc)
    report = models.Report(
        instrument_id=instrument.id,
        template_id=template.id,
        status=models.ReportStatus.extracted,
        extracted_fields=dict(SAMPLE_FIELDS),
        original_fields=dict(SAMPLE_FIELDS),
        report_date=SAMPLE_REPORT_DATE,
        is_sample=True,
    )
    db.add(report)
    db.flush()

    directory = get_settings().attachment_storage_path / str(report.id)
    directory.mkdir(parents=True, exist_ok=True)
    pdf_path = directory / SAMPLE_FILENAME
    pdf_path.write_bytes(_sample_pdf())
    attachment = models.Attachment(
        report_id=report.id,
        file_path=str(pdf_path),
        original_filename=SAMPLE_FILENAME,
        file_type="application/pdf",
        page_count=1,
    )
    db.add(attachment)
    db.flush()
    for kind, extra in (
        (models.ExtractionJobKind.classify, {"classification": SAMPLE_CLASSIFICATION}),
        (models.ExtractionJobKind.extract, {"field_confidences": SAMPLE_CONFIDENCES}),
    ):
        db.add(
            models.ExtractionJob(
                attachment_id=attachment.id,
                kind=kind,
                status=models.ExtractionJobStatus.succeeded,
                started_at=now,
                completed_at=now,
                **extra,
            )
        )
    db.commit()
    db.refresh(report)
    return report, True


def remove_sample_data(db: Session) -> bool:
    """Deletes every sample report (with its scan, jobs and files), then the demo instrument, model record and
    places. Returns whether anything was there. Real data is never touched: only rows flagged `is_sample`."""
    reports = db.query(models.Report).filter(models.Report.is_sample.is_(True)).all()
    directories = [get_settings().attachment_storage_path / str(r.id) for r in reports]
    instruments = db.query(models.Instrument).filter(models.Instrument.is_sample.is_(True)).all()
    records = db.query(models.InstrumentModel).filter(models.InstrumentModel.is_sample.is_(True)).all()
    places = db.query(models.Place).filter(models.Place.is_sample.is_(True)).all()
    if not (reports or instruments or records or places):
        return False
    for report in reports:
        db.delete(report)
    db.flush()
    for instrument in instruments:
        db.delete(instrument)
    db.flush()
    for record in records:
        db.delete(record)
    for place in sorted(places, key=lambda p: p.parent_id is None):  # rooms before their institution
        db.delete(place)
        db.flush()
    db.commit()
    for directory in directories:
        shutil.rmtree(directory, ignore_errors=True)
    return True
