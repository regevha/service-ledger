"""Spotting a visit that is already on file.

Two signals, either of which flags a probable duplicate:

* the same file bytes (SHA-256) — the same scan uploaded twice;
* the same work-order number read off the document — the same visit scanned
  twice as two different files (a re-scan, a phone photo of a printout).

Both warn, and only one case refuses: the same file bytes as a report that was
already *read* (extraction succeeded) is turned away at upload — reading it
again costs two model calls for no new information, and the existing report is
what the technician wants. See `find_read_copy`. A matching work-order number
never blocks: a re-scan may be a better copy, and a misread number must not be
able to stop anyone working.

`find_saved_duplicates` is the third consumer: it runs whenever an already-saved
report is opened, so a clash that exists in the database (not just one being
created) is flagged on that report's screen.
"""
from __future__ import annotations

import uuid

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Attachment, Report, ReportStatus


def normalize_work_order(value: object) -> str | None:
    """A work-order number as stored and compared: upper-case letters and
    digits only, without a leading "WO" ("WO-04587090" -> "04587090"). None
    for anything that cannot be a work-order number (empty, "N/A", too short,
    no digits) — an unreadable value must never match another unreadable one."""
    if not isinstance(value, str):
        return None
    text = "".join(ch for ch in value.upper() if ch.isalnum())
    if text.startswith("WO") and text[2:].isdigit():
        text = text[2:]
    if len(text) < 5 or not any(ch.isdigit() for ch in text):
        return None
    return text


def find_duplicate_report_ids(
    db: Session, attachment: Attachment, work_order: str | None = None
) -> list[uuid.UUID]:
    """Ids of *other* reports that already hold this document: an attachment
    with the same bytes, or with the same (normalized) work-order number.
    `work_order` defaults to the one already stored on the attachment."""
    work_order = work_order or attachment.work_order_number
    conditions = []
    if attachment.content_sha256:
        conditions.append(Attachment.content_sha256 == attachment.content_sha256)
    if work_order:
        conditions.append(Attachment.work_order_number == work_order)
    if not conditions:
        return []
    rows = (
        db.query(Attachment.report_id)
        .filter(
            Attachment.id != attachment.id,
            Attachment.report_id != attachment.report_id,
            or_(*conditions),
        )
        .distinct()
        .all()
    )
    return sorted((row[0] for row in rows), key=str)


# Statuses that mean extraction ran and succeeded (reports.py's pipeline: a
# draft or merely classified report has not been read in full).
_READ_STATUSES = (ReportStatus.extracted, ReportStatus.in_review, ReportStatus.finalized)


def find_read_copy(db: Session, content_sha256: str, exclude_report_id: uuid.UUID) -> Report | None:
    """The most recent *other* report whose attachment has exactly these bytes
    and which has already been read (extracted, in review or finalized), or
    None. A report whose first attempt failed or never got past classification
    does not count, so uploading the same file again stays a valid retry."""
    return (
        db.query(Report)
        .join(Attachment, Attachment.report_id == Report.id)
        .filter(
            Attachment.content_sha256 == content_sha256,
            Report.id != exclude_report_id,
            Report.status.in_(_READ_STATUSES),
        )
        .order_by(Report.created_at.desc())
        .first()
    )


def find_saved_duplicates(db: Session, report: Report) -> list[tuple[Report, str, str | None]]:
    """Other saved reports that probably record the same visit as `report`,
    for the indicator on an already-saved report (unlike
    `find_duplicate_report_ids`, which runs while a report is being created).
    Returns (other report, reason, work-order number) oldest first, where
    reason is "same_file" or "same_work_order":

    * same_file: one of the other report's scans has exactly the same bytes as
      one of this report's — the same document, whatever instrument it is on;
    * same_work_order: the same normalized work-order number on the *same
      instrument* (both reports must have one). One work order can legitimately
      cover several instruments, so the same number on a different instrument
      is not flagged here (intake still warns about it).

    Based on the stored scans' hash and work-order number, so it needs no
    model call and is cheap enough to run every time a report is opened."""
    shas = {a.content_sha256 for a in report.attachments if a.content_sha256}
    orders = {a.work_order_number for a in report.attachments if a.work_order_number}
    conditions = []
    if shas:
        conditions.append(Attachment.content_sha256.in_(shas))
    if orders and report.instrument_id is not None:
        conditions.append(
            (Attachment.work_order_number.in_(orders)) & (Report.instrument_id == report.instrument_id)
        )
    if not conditions:
        return []
    rows = (
        db.query(Report, Attachment)
        .join(Attachment, Attachment.report_id == Report.id)
        .filter(Report.id != report.id, or_(*conditions))
        .order_by(Report.created_at, Report.id)
        .all()
    )
    found: dict[uuid.UUID, tuple[Report, str, str | None]] = {}
    for other, attachment in rows:
        same_file = attachment.content_sha256 in shas
        reason = "same_file" if same_file else "same_work_order"
        previous = found.get(other.id)
        if previous is None or (reason == "same_file" and previous[1] != "same_file"):
            found[other.id] = (other, reason, attachment.work_order_number)
    return list(found.values())
