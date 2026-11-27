"""Render a stored PDF page in its original orientation, including form values."""
from __future__ import annotations

import io
from pathlib import Path

import pypdfium2 as pdfium  # type: ignore[import-untyped]

from app.services.page_text import PDFIUM_LOCK

MAX_RENDER_PIXELS = 25_000_000


def render_pdf_page(
    path: Path,
    page: int,
    width: int,
    max_edge: int | None = None,
) -> bytes:
    with PDFIUM_LOCK:
        pdf = pdfium.PdfDocument(str(path))
        try:
            if not 1 <= page <= len(pdf):
                raise IndexError(page)
            # Typed values in fillable forms are drawn only with a form environment.
            pdf.init_forms()
            pdf_page = pdf[page - 1]
            page_w, page_h = pdf_page.get_size()
            # The area limit also handles small files advertising extremely large pages.
            scale = min(width / page_w, (0.98 * MAX_RENDER_PIXELS / (page_w * page_h)) ** 0.5)
            if max_edge is not None:
                scale = min(scale, max_edge / max(page_w, page_h))
            image = pdf_page.render(scale=scale, may_draw_forms=True).to_pil().convert("RGB")
        finally:
            pdf.close()
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
