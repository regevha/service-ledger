"""A PDF copy of an HTML report, for the side-by-side review view.

The stored file stays the original HTML (it is what people download and what duplicate detection hashes).
The copy is made once, with headless Chromium, and kept beside the original as `<name>.display.pdf`.
The page is rendered with scripts off and every network request refused, from a string (so it has no
file or web origin): a file cannot run code, read the server's files or fetch outside content. When
Chromium is not installed or the render fails, `ensure_display_pdf` returns None and the screens show the
extracted text instead (services/html_text.py), so nothing depends on it.
"""
from __future__ import annotations

import logging
import os
import re
import threading
from pathlib import Path

from app.config import get_settings
from app.services.html_text import decode_html

logger = logging.getLogger("app.services.html_pdf")

# One Chromium at a time: a render is memory-heavy, and the copy is cached, so a queue is cheap.
_RENDER_LOCK = threading.Lock()

# Hebrew and other right-to-left text lays out from its own first letter; A4 pages with a small margin.
_PRINT_STYLE = (
    "<meta charset=\"utf-8\"><style>@page{size:A4;margin:12mm}"
    "body{unicode-bidi:plaintext;font-family:'Noto Sans Hebrew','DejaVu Sans',Arial,sans-serif;font-size:11pt}"
    "table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:2px 6px}img{max-width:100%}</style>"
)
_HEAD_OPEN = re.compile(r"<head[^>]*>", re.IGNORECASE)


def display_pdf_path(html_path: Path) -> Path:
    return html_path.with_name(html_path.name + ".display.pdf")


def _prepared(html: str) -> str:
    # Drop the page's own charset claim: the string is already decoded.
    html = re.sub(r"<meta[^>]+charset[^>]*>", "", html, flags=re.IGNORECASE)
    if _HEAD_OPEN.search(html):
        return _HEAD_OPEN.sub(lambda m: m.group(0) + _PRINT_STYLE, html, count=1)
    return f"<head>{_PRINT_STYLE}</head>{html}"


def render_html_to_pdf(html_bytes: bytes) -> bytes:
    """The PDF bytes for `html_bytes`. Raises when Chromium is missing or the page cannot be rendered."""
    from playwright.sync_api import sync_playwright

    settings = get_settings()
    args = ["--disable-extensions", "--disable-dev-shm-usage"]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.append("--no-sandbox")  # Chromium refuses to start as root without it
    timeout_ms = settings.html_pdf_timeout_seconds * 1000
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path=settings.html_pdf_chromium_path or None, args=args, timeout=timeout_ms
        )
        try:
            context = browser.new_context(java_script_enabled=False, offline=True, accept_downloads=False)
            context.route("**/*", lambda route: route.abort())
            page = context.new_page()
            page.set_content(_prepared(decode_html(html_bytes)), wait_until="load", timeout=timeout_ms)
            return page.pdf(format="A4", print_background=True)
        finally:
            browser.close()


def ensure_display_pdf(html_path: Path) -> Path | None:
    """The PDF copy of the stored HTML file, made now if it does not exist yet; None when it cannot be made."""
    target = display_pdf_path(html_path)
    if target.exists():
        return target
    with _RENDER_LOCK:
        if target.exists():
            return target
        try:
            pdf = render_html_to_pdf(html_path.read_bytes())
        except Exception as e:  # noqa: BLE001 - a missing browser or a bad page must only cost the preview
            logger.warning("Could not render a PDF copy of %s: %s", html_path.name, str(e).splitlines()[0] if str(e) else type(e).__name__)
            return None
        tmp = target.with_name(target.name + f".{os.getpid()}.tmp")
        tmp.write_bytes(pdf)
        os.replace(tmp, target)
        return target
