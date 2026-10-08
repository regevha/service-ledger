"""Reading a service report without calling Claude.

A BD service report is usually a text PDF (or a fillable form), so the facts
that identify it are already in the file: the work-order number, the task
code, the "<product code> - <model name>" line and the instrument's serial
number. This module pulls them out with plain parsing — no network, no API
key, no model — which does two jobs:

* with no Anthropic key (USE_LIVE_CLAUDE=false) classification reads the real
  document instead of inventing an answer (classification.py);
* every upload is read for its work-order number straight away, so a probable
  duplicate is flagged even before classification runs (routers/attachments.py).

It only identifies the document. Reading the template's fields (what was
done, parts, labor, the visit date) needs the model; this makes no attempt at
that. A scanned image or a PDF with no text layer yields no text, and callers
fall back to what they did before.

pypdf joins a label to the value beside it ("Work Order Task CodeT113"), so
every pattern here anchors on the label or on what follows the value, never on
a word boundary before it.
"""
from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass

logger = logging.getLogger("app.services.text_reader")

# Identifying facts sit on the first page or two; reading no more bounds the
# time an upload can spend here.
MAX_PAGES = 3


def extract_text(data: bytes, max_pages: int = MAX_PAGES) -> str:
    """The text of the first pages of a PDF, followed by the values of its
    fillable form fields (a BD Product Intervention Report Form keeps its
    content there, not in the page text). Empty when `data` is not a readable
    PDF or has no text — never raises."""
    if b"%PDF-" not in data[:1024]:
        return ""
    try:
        from pypdf import PdfReader  # imported here so a missing library degrades to "no text"

        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            return ""
        parts = [(page.extract_text() or "") for page in reader.pages[:max_pages]]
        try:
            fields = reader.get_fields() or {}
        except Exception:  # a malformed form must not hide the page text
            fields = {}
        for field in fields.values():
            value = field.get("/V")
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
        return "\n".join(parts)
    except Exception as e:
        logger.debug("Could not read a text layer from the PDF: %s", e)
        return ""


# "WORK ORDER NUMBER: WO-03424229" on a service report. WO-… anywhere else is
# a fallback (a form that names the work order in a free-text field).
_WORK_ORDER_LABELLED = re.compile(r"WORK ORDER NUMBER:?\s*(WO-\d{5,})", re.IGNORECASE)
_WORK_ORDER_ANY = re.compile(r"(?<![A-Za-z])(WO-\d{5,})")

# "Work Order Task CodeT113 Repair / Troubleshooting Visit" (joined by pypdf),
# or a form's dropdown value "T113 Repair / Troubleshooting Visit". A bare
# T\d\d\d anywhere is deliberately not accepted: part numbers look like it.
_TASK_CODE_LABELLED = re.compile(r"Task Code\s*(T\d{3})(?!\d)", re.IGNORECASE)
_TASK_CODE_DESCRIBED = re.compile(
    r"(?<![A-Za-z0-9])(T\d{3})(?=\s+(?:Repair|Preventive|Preventative|Install|Calibrat))", re.IGNORECASE
)

# "647794E6 - LSRFortessa SO": the Installed Product line. Parts tables use the
# same "<number> - <name>" shape, so a line only counts when its name is one of
# the fleet's models.
# No guard before the code: pypdf can glue the previous label to it
# ("N/A665158 - FACSDiscover S8"), and a code always starts with a digit.
_PRODUCT_LINE = re.compile(r"([0-9][0-9A-Z]{4,9})\s+-\s+([^\n]+)")


@dataclass(frozen=True)
class TextRead:
    """What the text layer says about a document. Every field is None when the
    document does not state it."""

    work_order_number: str | None = None
    task_code: str | None = None
    product_code: str | None = None
    model: str | None = None  # one of the fleet's models
    serial: str | None = None

    @property
    def recognised(self) -> bool:
        """Looks like a BD service document: at least one identifier found."""
        return any((self.work_order_number, self.task_code, self.product_code, self.model))


def _model_key(model: str) -> str:
    """"FACSAria III" -> "ariaiii", "LSRFortessa" -> "lsrfortessa". BD prints
    the product name without the FACS prefix ("ARIA III ACDU 6B/3R/3V")."""
    key = re.sub(r"\s+", "", model).lower()
    return key[4:] if key.startswith("facs") else key


def read_work_order(text: str) -> str | None:
    """The work-order number as printed ("WO-03424229"), or None."""
    match = _WORK_ORDER_LABELLED.search(text) or _WORK_ORDER_ANY.search(text)
    return match.group(1).upper() if match else None


def read_identifiers(text: str, models: list[str]) -> TextRead:
    """Parses the identifying facts out of `text`. `models` are the fleet's
    model names: the Installed Product line is only trusted when its name is
    one of them."""
    work_order = read_work_order(text)
    code_match = _TASK_CODE_LABELLED.search(text) or _TASK_CODE_DESCRIBED.search(text)
    task_code = code_match.group(1).upper() if code_match else None

    # Longest key first, so "Aria III" is never shadowed by a shorter "Aria II".
    keyed = sorted(((_model_key(m), m) for m in set(models)), key=lambda pair: len(pair[0]), reverse=True)
    product_code = model = serial = None
    for line in _PRODUCT_LINE.finditer(text):
        name = re.sub(r"\s+", "", line.group(2)).lower()
        found = next((m for key, m in keyed if key and key in name), None)
        if found is None:
            continue
        product_code, model = line.group(1), found
        # The serial number embeds the product code ("R647794E6092",
        # "MP6651580000057"): the first such token after the product line. A
        # token equal to the code itself is the product line, not a serial.
        token = re.compile(rf"(?<![A-Za-z0-9])([A-Z]{{0,3}}{re.escape(product_code)}[0-9A-Z]+)(?![A-Za-z0-9])")
        serial_match = token.search(text, line.end())
        serial = serial_match.group(1) if serial_match else None
        break

    return TextRead(work_order, task_code, product_code, model, serial)
