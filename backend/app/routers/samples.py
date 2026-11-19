"""The first-run sample report (services/samples.py)."""
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.services import samples

router = APIRouter(tags=["sample"])


@router.post("/sample-report", response_model=schemas.SampleReportOut, status_code=201)
def open_sample_report(response: Response, db: Session = Depends(get_db)):
    """Opens the sample report, making it (with its demo instrument and place) when there is none yet. Asking
    again returns the same one (200). Nothing is sent to Claude."""
    try:
        report, created = samples.create_sample(db)
    except samples.SampleUnavailable as exc:
        raise HTTPException(409, str(exc)) from exc
    if not created:
        response.status_code = 200
    out = schemas.SampleReportOut.model_validate(report)
    out.field_confidences = samples.stored_confidences(db, report)
    return out


@router.delete("/sample-report", status_code=204)
def delete_sample_report(db: Session = Depends(get_db)):
    """Removes the sample report and everything made for it. 204 even when there is none."""
    samples.remove_sample_data(db)
    return Response(status_code=204)
