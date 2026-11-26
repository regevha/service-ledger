"""Store a validated file for the web and email report inputs."""
from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from sqlalchemy.orm import Session

from app import models
from app.config import get_settings

from .attachment_names import clean_original_filename, stored_filename
from .documents import HTML, PDF
from .duplicates import normalize_work_order
from .page_text import count_pdf_pages
from .text_reader import extract_text, read_work_order


def store_attachment(
    db: Session,
    report_id: uuid.UUID,
    contents: bytes,
    media_type: str,
    filename: str | None,
    *,
    pdf_pages: int | None = None,
    pdf_text: str | None = None,
) -> tuple[models.Attachment, Path]:
    """Write the scan and add its row. The caller owns the transaction."""
    report_dir = get_settings().attachment_storage_path / str(report_id)
    report_dir.mkdir(parents=True, exist_ok=True)
    dest = report_dir / stored_filename(media_type)
    order = None
    if media_type in (PDF, HTML):
        order = normalize_work_order(read_work_order(pdf_text if pdf_text is not None else extract_text(contents)))
    attachment = models.Attachment(
        report_id=report_id,
        file_path=str(dest),
        original_filename=clean_original_filename(filename, media_type),
        file_type=media_type,
        page_count=(pdf_pages if pdf_pages is not None else count_pdf_pages(contents)) if media_type == PDF else 1,
        content_sha256=hashlib.sha256(contents).hexdigest(),
        work_order_number=order,
    )
    try:
        dest.write_bytes(contents)
    except OSError:
        dest.unlink(missing_ok=True)
        raise
    db.add(attachment)
    return attachment, dest
