"""Seeds about 60 finalized reports over the last ten weeks, each with a first reading and some corrections, so the
Admin "Reading accuracy" page has something to show in a demo: a rising weekly line toward the 99% goal, the
fields that miss most, and a few Hebrew reports whose translation said "laser direction" for laser alignment.

Synthetic presentation data, not from real documents. Not run at startup (the test databases assert on report
counts); run it by hand against a development database:

    python -m app.seed_accuracy_demo

Idempotent: keyed on the technician name prefix, so a second run does nothing.
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    Attachment,
    Instrument,
    Report,
    ReportStatus,
    ReportType,
    Translation,
    TranslationStatus,
)
from app.seed_trend_demo import _make_placeholder_pdf
from app.services.templates import resolve_template

settings = get_settings()

PREFIX = "Demo accuracy"
WEEKS = 10
PER_WEEK = 8

FAULTS = ["Clog in the sample line", "Laser power low on the blue laser", "Fluidics pressure alarm", "Noisy signal on the violet detectors", "Sort stream unstable"]
CAUSES = ["Worn pinch valve", "Air in the sheath filter", "Dirty flow cell", "Loose fibre connector", "Aged laser module"]
WORK = [
    "Cleaned the flow cell and replaced the sheath filter; ran CST, passed.",
    "Laser alignment checked and adjusted; ran QC beads, all detectors in range.",
    "Replaced the pinch valve and ran a fluidics startup; no alarms.",
    "Recalibrated the fluidics pressure and checked for leaks.",
]
# A read value and what a person approved instead, per field: the kind of mistakes the page should show.
MISREADS = {
    "labor_hours": lambda v: (v + 0.5, v),
    "fault_description": lambda v: (v + " S/N R1000000042", v),
    "root_cause": lambda v: ("Dirty", v),
    "work_performed": lambda v: (v.replace("Laser alignment", "Laser direction"), v),
    "service_description": lambda v: ("PM", v),
}


def _value(field: dict, rng: random.Random):
    name, kind = field["name"], field["type"]
    if name == "labor_hours":
        return rng.choice([1.0, 1.5, 2.0, 2.5, 3.0, 4.0])
    if name == "fault_description":
        return rng.choice(FAULTS)
    if name == "root_cause":
        return rng.choice(CAUSES)
    if name in ("work_performed", "service_description"):
        return rng.choice(WORK)
    if kind == "number":
        return round(rng.uniform(1, 50), 1)
    if kind == "enum" and field.get("options"):
        return rng.choice(field["options"])
    if kind == "text":
        return "As per checklist"
    return None


def seed(db: Session) -> int:
    if db.query(Report).filter(Report.technician_name.like(f"{PREFIX}%")).first():
        return 0
    instruments = db.query(Instrument).order_by(Instrument.name).all()
    if not instruments:
        return 0
    rng = random.Random(7)
    today = date.today()
    made = 0
    for week in range(WEEKS):
        # Earlier weeks miss more: from about 1 field in 4 down to about 1 in 100.
        miss_rate = 0.25 * (1 - week / (WEEKS - 1)) ** 1.5 + 0.01
        monday = today - timedelta(days=today.weekday()) - timedelta(weeks=WEEKS - 1 - week)
        for i in range(PER_WEEK):
            instrument = instruments[(week * PER_WEEK + i) % len(instruments)]
            report_type = ReportType.repair if i % 2 == 0 else ReportType.preventive_maintenance
            template = resolve_template(db, instrument_type=instrument.instrument_type, report_type=report_type.value, model=instrument.model)
            if template is None:
                continue
            original: dict = {}
            kept: dict = {}
            hebrew = i == 3 and week % 2 == 1
            for field in template.field_schema.get("fields", []):
                value = _value(field, rng)
                if value is None:
                    continue
                read = value
                if field["name"] == "work_performed" and hebrew:
                    value = WORK[1]
                    read = value.replace("Laser alignment", "Laser direction") if week < 7 else value
                elif field["name"] in MISREADS and rng.random() < miss_rate:
                    read, value = MISREADS[field["name"]](value)
                original[field["name"]] = read
                kept[field["name"]] = value
            finalized = datetime.combine(min(monday + timedelta(days=i % 5), today), time(10 + i), tzinfo=timezone.utc)
            report = Report(
                instrument_id=instrument.id,
                template_id=template.id,
                status=ReportStatus.finalized,
                original_fields=original,
                extracted_fields=kept,
                technician_name=f"{PREFIX} {week}-{i}",
                report_date=finalized.date() - timedelta(days=1),
                created_at=finalized - timedelta(hours=2),
                finalized_at=finalized,
            )
            db.add(report)
            db.flush()
            folder = settings.attachment_storage_path / str(report.id)
            folder.mkdir(parents=True, exist_ok=True)
            pdf = folder / "accuracy_demo.pdf"
            pdf.write_bytes(_make_placeholder_pdf(["Demo seed data - reading accuracy", "", "Synthetic report, see backend/app/seed_accuracy_demo.py."]))
            attachment = Attachment(report_id=report.id, file_path=str(pdf), original_filename=pdf.name, file_type="application/pdf", page_count=1)
            db.add(attachment)
            db.flush()
            if hebrew:
                model_text = f"Service report (demo translation)\nWork: {original.get('work_performed', WORK[1])}\nEngineer signature: signed."
                db.add(
                    Translation(
                        attachment_id=attachment.id,
                        status=TranslationStatus.accepted,
                        source_language="he",
                        hebrew_share=0.8,
                        model_text=model_text,
                        accepted_text=model_text.replace("Laser direction", "Laser alignment"),
                        reader="stub",
                        accepted_at=finalized,
                    )
                )
            made += 1
    db.commit()
    return made


if __name__ == "__main__":
    with SessionLocal() as session:
        print(f"Seeded {seed(session)} finalized demo reports with first readings and corrections.")
