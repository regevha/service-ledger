"""Pydantic shapes: reports (part of app/schemas, see __init__.py)."""
from __future__ import annotations

import uuid
from typing import Literal
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.models import (
    ReportStatus,
    ReportType,
)


# ---------- Attachments ----------


class AttachmentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    report_id: uuid.UUID
    file_path: str
    # The uploader's own file name (null on an old row that has none).
    original_filename: str | None = None
    file_type: str
    page_count: int
    # Status of the current translation (pending_review, accepted, discarded,
    # not_needed), or None when the document never went through the translate step.
    translation_status: str | None = None
    # Set only on the upload response: other reports that already hold a file
    # with these exact bytes, or whose PDF text names the same work order. A
    # warning, never a rejection.
    duplicate_report_ids: list[uuid.UUID] = []


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
    # Who issued the form and a second report type, when classification read
    # them off the document (see ClassificationResult).
    issuer: str | None = None
    report_type_note: str | None = None
    service_actions: str | None
    parts_replaced: str | None
    next_service_due: date | None
    report_date: date | None
    created_at: datetime
    finalized_at: datetime | None
    # The report screen's "view original scan" link (§4/§9 gap noticed while
    # testing the demo build — GET /reports/{id} previously carried no way
    # back to the attachment that produced it) reads off this list rather
    # than a separate GET /reports/{id}/attachments round trip, since
    # ReportOut already loads the ORM row this hangs off of for free via the
    # existing Report.attachments relationship.
    attachments: list[AttachmentOut] = []


class SnippetPiece(BaseModel):
    """One run of an excerpt: plain text, and whether it is a matched word.
    The server never sends HTML; the screen wraps matched pieces itself."""

    text: str
    matched: bool


class ReportListItemOut(BaseModel):
    """§7/§9: the denormalized shape GET /reports (filtered search) returns —
    distinct from ReportOut, which stays the raw single-report detail shape
    the review flow (PATCH .../fields, .../finalize) round-trips against.
    A list screen needs instrument_model/report_type to render a readable
    row without an extra round trip per report, so this builds them from the
    same instrument/template relationships export_reports already reads —
    it just returns them as JSON instead of flattening straight to CSV."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    status: ReportStatus
    instrument_model: str | None
    instrument_serial_number: str | None
    report_type: ReportType | None
    technician_name: str | None
    report_date: date | None
    created_at: datetime
    finalized_at: datetime | None
    # Only when the list was searched (`q`): a short excerpt around the first
    # match, and the label of the field it came from.
    snippet: list[SnippetPiece] | None = None
    matched_field: str | None = None


class DuplicateReportOut(ReportListItemOut):
    """One entry of GET /reports/{id}/duplicates: another saved report that
    probably records the same visit as this one, in the list-item shape so a
    screen can show and open it without another lookup.

    `reason` is `same_file` (the other report holds a scan with exactly these
    bytes) or `same_work_order` (a scan carrying the same normalized work-order
    number, on the same instrument). If both apply, `same_file` is reported."""

    reason: Literal["same_file", "same_work_order"]
    work_order_number: str | None = None


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


class WordBoxOut(BaseModel):
    """One word on a PDF page and where it sits, as fractions of the page
    (0 to 1 from the top left), so the browser can draw it over the page image
    at any size. `line` counts lines down the page from 0."""

    text: str
    x: float
    y: float
    w: float
    h: float
    line: int


class PageWordsOut(BaseModel):
    """GET /attachments/{id}/pages/{n}/words: the words the template editor
    lets a person pick. `has_text` is false for a scan with no text layer."""

    page: int
    has_text: bool
    words: list[WordBoxOut]


class ReportSearchParseIn(BaseModel):
    text: str = Field(min_length=1, max_length=300)


class ReportSearchPart(BaseModel):
    """One thing that was understood from the request, in the words to show next to the filters."""

    key: str
    label: str


class ReportSearchParseOut(BaseModel):
    """The Reports filters a plain-words request asked for (the same keys GET /reports takes), plus what
    was understood from it."""

    filters: dict[str, str]
    understood: list[ReportSearchPart]


class RectOut(BaseModel):
    """A box on a page, as fractions of it (0 to 1, from the top left)."""

    x: float
    y: float
    w: float
    h: float


class FieldLocationOut(BaseModel):
    """Where one field's value sits on the document. `source` is "text" when it was found among the page's
    words and "template" when it is the position the template gives. `ambiguous` means the same text is on the
    page several times and nothing told them apart, so the position is a guess."""

    page: int
    rects: list[RectOut]
    matches: int
    ambiguous: bool
    source: str


class FieldLocationsOut(BaseModel):
    """GET /attachments/{id}/field-locations: for each field of the report this document produced, where its
    value is on the page. Only fields that could be placed are listed. `has_text` is false for a scan or photo,
    which has no text layer to search."""

    has_text: bool
    page_count: int
    fields: dict[str, FieldLocationOut]
