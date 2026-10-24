"""First-run help: a sample report to try, demo data to look at, and a view of
whether the background worker is keeping up.

* GET /onboarding/sample-report: a fresh sample service report (PDF) for the
  "Try a sample report" button. The page fetches it and sends it through the
  ordinary upload -> classify -> review flow, so nothing here is special-cased.
* POST/DELETE /onboarding/demo-data: load the demo reports (app/seed_demo_reports.py
  and app/seed_trend_demo.py, the same data the command-line scripts add), or
  remove them again. Removal also takes the reports made from the sample report,
  and only reports that carry the demo markers (a "Demo - " technician name and
  a demo scan), never one a person uploaded.
* GET /onboarding/status: counts and the queue's age, behind the empty-state
  prompts and the "worker is not running" banner.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import models, schemas, seed_demo_reports, seed_trend_demo
from app.db import get_db
from app.services.report_deletion import count_in_flight_jobs, remove_report_files
from app.services.sample_report import build_sample_report

router = APIRouter(prefix="/onboarding", tags=["onboarding"])

# What marks a report as demo data: the technician is named "Demo - ..." and
# its scan is either a placeholder PDF the seed scripts store, or the sample
# report the "Try a sample report" button uploads (stored as "<uuid>_<name>").
_DEMO_PREFIX = "Demo - "
_DEMO_FILE_NAMES = {"demo_seed_placeholder.pdf", "trend_seed_placeholder.pdf"}
_SAMPLE_UPLOAD = re.compile(r"^[0-9a-f-]{36}_sample-service-report\.pdf$")


def _is_demo_scan(file_path: str) -> bool:
    name = Path(file_path).name
    return name in _DEMO_FILE_NAMES or bool(_SAMPLE_UPLOAD.match(name))


def _is_demo(report: models.Report) -> bool:
    return (
        (report.technician_name or "").startswith(_DEMO_PREFIX)
        and bool(report.attachments)
        and all(_is_demo_scan(a.file_path) for a in report.attachments)
    )


def _demo_reports(db: Session) -> list[models.Report]:
    candidates = db.query(models.Report).filter(models.Report.technician_name.like(f"{_DEMO_PREFIX}%")).all()
    return [r for r in candidates if _is_demo(r)]


@router.get("/sample-report", response_class=Response, responses={200: {"content": {"application/pdf": {}}}})
def sample_report():
    """A new sample service report every call (different work-order number, so
    different bytes: the app refuses a file already on file)."""
    name, data = build_sample_report()
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{name}"', "Cache-Control": "no-store"},
    )


@router.get("/status", response_model=schemas.OnboardingStatusOut)
def status(db: Session = Depends(get_db)):
    pending = models.ExtractionJob.status == models.ExtractionJobStatus.pending
    count, oldest = db.query(func.count(models.ExtractionJob.id), func.min(models.ExtractionJob.started_at)).filter(pending).one()
    waited = (datetime.now(timezone.utc) - oldest).total_seconds() if oldest else None
    return schemas.OnboardingStatusOut(
        instruments=db.query(models.Instrument).count(),
        reports=db.query(models.Report).count(),
        finalized_reports=db.query(models.Report).filter(models.Report.status == models.ReportStatus.finalized).count(),
        demo_reports=len(_demo_reports(db)),
        pending_jobs=count,
        oldest_pending_seconds=max(waited, 0.0) if waited is not None else None,
    )


@router.post("/demo-data", response_model=schemas.DemoDataOut)
def load_demo_data(db: Session = Depends(get_db)):
    """Load the demo reports: three finalized reports (repair and preventive
    maintenance) and a five-point calibration series for the FACSAria III, so
    the Reports, Analytics and instrument trend screens have something to show.
    Loading twice adds nothing the second time."""
    before = len(_demo_reports(db))
    seed_demo_reports.seed(db)
    seed_trend_demo.seed(db)
    after = len(_demo_reports(db))
    if after == 0:
        raise HTTPException(
            409,
            "The demo reports belong to the FACSAria III, LSRFortessa and FACSDiscover S8, "
            "which are not on the Instruments tab. Add them first.",
        )
    return schemas.DemoDataOut(reports_added=after - before, demo_reports=after)


@router.delete("/demo-data", response_model=schemas.DemoDataOut)
def remove_demo_data(db: Session = Depends(get_db)):
    """Remove the demo reports again, and the reports made from the sample report."""
    reports = _demo_reports(db)
    if count_in_flight_jobs(db, [a.id for r in reports for a in r.attachments]):
        raise HTTPException(409, "A demo report is still being read. Try again in a moment.")
    removed = [(r.id, [a.file_path for a in r.attachments]) for r in reports]
    for report in reports:
        db.delete(report)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "The demo reports changed while they were being removed. Try again.") from None
    for report_id, paths in removed:
        remove_report_files(report_id, paths)
    return schemas.DemoDataOut(reports_removed=len(removed), demo_reports=len(_demo_reports(db)))
