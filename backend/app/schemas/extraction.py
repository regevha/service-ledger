"""Pydantic shapes: extraction (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from typing import Literal
from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator

from app.models import (
    ExtractionJobKind,
    ExtractionJobStatus,
    TranslationStatus,
)


# ---------- Extraction jobs / classification ----------


class ClassificationGuess(BaseModel):
    value: str
    confidence: float


class ClassificationResult(BaseModel):
    instrument: ClassificationGuess
    report_type: ClassificationGuess
    # The instrument serial number as printed on the document, with Claude's
    # confidence in the read; None when the document shows none (or "N/A").
    instrument_serial: ClassificationGuess | None = None
    # What matching that serial against the fleet found:
    #   matched         exactly one fleet instrument has this serial
    #   not_found       a serial was read but no instrument has it
    #   model_conflict  it matches an instrument whose model is not the model
    #                   read from the document, so one of the two reads is wrong
    #   not_read        no serial on the document
    serial_match: Literal["matched", "not_found", "model_conflict", "not_read"] = "not_read"
    # The instrument the confirm screen should pre-select: the one the serial
    # matched, else the only unit of the guessed model, else None.
    suggested_instrument_id: uuid.UUID | None = None
    # Present only when both guesses cleared the classification threshold and
    # a template could be resolved automatically (§4 step 3).
    resolved_template_id: uuid.UUID | None = None
    resolved_instrument_id: uuid.UUID | None = None
    # Where report_type came from: "task_code" when it was derived from the
    # printed Work Order Task Code (T113 -> repair, T111 -> PM) by a lookup in
    # code, "model" when it is Claude's own judgment of the document.
    report_type_source: Literal["task_code", "model", "none"] = "model"
    # Who read the document: "model" (Claude), "text_layer" (the PDF's own text
    # parsed in code, no API key), or "stub" (demo answer for a file with no text).
    reader: Literal["model", "text_layer", "stub"] = "model"
    # The work-order number as printed, when one was read.
    work_order_number: str | None = None
    # Read off a document from another company's form: who issued it (often a
    # distributor), the instrument's maker as far as the model could tell, False
    # when that instrument is not any model in the fleet (the instrument guess is
    # then a zero-confidence placeholder for the manual pick), and a note when the
    # visit fits a second report type.
    issuer: str | None = None
    detected_manufacturer: str | None = None
    maker_in_fleet: bool = True
    report_type_note: str | None = None
    # The instrument's model name as printed (for example "Cytek Aurora"), so
    # the intake screen can offer to add it to the fleet.
    detected_model: str | None = None
    # Other reports that already hold this document — same file bytes or same
    # work-order number. Empty when none; the intake screen should warn, not block.
    duplicate_report_ids: list[uuid.UUID] = []


class TranslateRequest(BaseModel):
    """POST /attachments/{id}/translate. `include_pages` asks for pages the model
    would otherwise skip as instrument QC printouts to be translated too."""

    include_pages: list[int] = []

    @field_validator("include_pages")
    @classmethod
    def _pages_positive(cls, v: list[int]) -> list[int]:
        if any(p < 1 for p in v):
            raise ValueError("Page numbers start at 1")
        return sorted(set(v))


class TranslationAccept(BaseModel):
    """POST /translations/{id}/accept. Omit `accepted_text` to accept the model's
    text as it is; send it to accept an edited version."""

    accepted_text: str | None = None

    @field_validator("accepted_text")
    @classmethod
    def _not_blank(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.strip():
            raise ValueError("The accepted translation cannot be empty")
        if len(v) > 200_000:
            raise ValueError("The accepted translation is too long")
        return v


class TranslationOut(BaseModel):
    # `model_text` and `model` start with pydantic's protected "model_" prefix.
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

    id: uuid.UUID
    attachment_id: uuid.UUID
    status: TranslationStatus
    source_language: str
    hebrew_share: float | None
    model_text: str | None
    accepted_text: str | None
    ignored_pages: list[dict]
    included_pages: list[int]
    identifier_check: dict
    notes: list[str]
    reader: str
    model: str | None
    created_at: datetime
    accepted_at: datetime | None


class ExtractionJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    attachment_id: uuid.UUID
    kind: ExtractionJobKind
    status: ExtractionJobStatus
    classification: dict | None
    field_confidences: dict | None
    error_message: str | None = None
    prompt_preview: dict | None = None
    started_at: datetime | None
    completed_at: datetime | None
