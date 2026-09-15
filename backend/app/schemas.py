"""Pydantic request/response shapes for the API in app/routers/.

Kept close to the ORM models but separate from them on purpose — a report in
`draft` has no instrument or template yet (§4/§5), so the response shape has
to make those genuinely optional rather than just nullable columns leaking
through.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict

from app.models import ExtractionJobStatus, InstrumentStatus, ReportStatus, ReportType


# ---------- Instruments ----------


class InstrumentCreate(BaseModel):
    name: str
    instrument_type: str = "facs"
    model: str
    serial_number: str
    location: str | None = None


class InstrumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    instrument_type: str
    model: str
    serial_number: str
    location: str | None
    status: InstrumentStatus


# ---------- Report templates ----------


class ReportTemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    instrument_type: str
    report_type: ReportType
    model: str | None
    field_schema: dict


# ---------- Reports ----------


class ReportCreate(BaseModel):
    """§9: POST /reports starts a bare draft — no instrument or template yet."""

    technician_name: str | None = None
    report_date: date | None = None


class ReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    instrument_id: uuid.UUID | None
    template_id: uuid.UUID | None
    status: ReportStatus
    extracted_fields: dict
    technician_name: str | None
    service_actions: str | None
    parts_replaced: str | None
    next_service_due: date | None
    report_date: date | None
    created_at: datetime
    finalized_at: datetime | None


class ReportFieldsUpdate(BaseModel):
    """§9: PATCH /reports/{id}/fields — overwrites in place, no audit log in MVP."""

    extracted_fields: dict | None = None
    technician_name: str | None = None
    service_actions: str | None = None
    parts_replaced: str | None = None
    next_service_due: date | None = None
    report_date: date | None = None


class TemplateConfirmation(BaseModel):
    """§9: PATCH /reports/{id}/template — confirm or override what classify
    guessed. An override re-triggers extraction (§4, §6)."""

    instrument_id: uuid.UUID
    template_id: uuid.UUID


# ---------- Attachments ----------


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    report_id: uuid.UUID
    file_path: str
    file_type: str
    page_count: int


# ---------- Extraction jobs / classification ----------


class ClassificationGuess(BaseModel):
    value: str
    confidence: float


class ClassificationResult(BaseModel):
    instrument: ClassificationGuess
    report_type: ClassificationGuess
    # Present only when both guesses cleared the classification threshold and
    # a template could be resolved automatically (§4 step 3).
    resolved_template_id: uuid.UUID | None = None
    resolved_instrument_id: uuid.UUID | None = None


class ExtractionJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    attachment_id: uuid.UUID
    status: ExtractionJobStatus
    classification: dict | None
    field_confidences: dict | None
    started_at: datetime | None
    completed_at: datetime | None
