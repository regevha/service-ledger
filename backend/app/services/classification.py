"""Classification service — §4 step 3.

`classify()` is the one function a real Claude vision call replaces later.
Its signature and return shape (a guess + confidence for instrument, a guess
+ confidence for report type) are the actual contract the rest of the app is
built against — the live path added below (behind `settings.use_live_claude`)
changes only this file's insides, exactly as the spec's swap-out plan says.

The stub is deterministic (seeded from the attachment's id/path) rather than
randomly noisy, so a demo run is reproducible. It also special-cases the real
sample BD Care Work Order used throughout the spec: that document genuinely
has a confident instrument read and a borderline report-type read (§4's
"same generic layout for a repair, a PM visit, or a calibration" point), so
the stub reproduces that exact asymmetry rather than pretending every
document is easy.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import time
from pathlib import Path

import anthropic
from anthropic import Anthropic
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Attachment, Instrument, ReportTemplate, ReportType
from app.schemas import ClassificationGuess, ClassificationResult
from app.services.errors import ClassificationError
from app.services.templates import resolve_template

logger = logging.getLogger("app.services.classification")
settings = get_settings()

_SAMPLE_MARKERS = ("wo-04587090", "sample", "work_order", "work-order")

_client: Anthropic | None = None


def _get_client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic(
            api_key=settings.anthropic_api_key,
            timeout=settings.anthropic_timeout_seconds,
            max_retries=settings.anthropic_max_retries,
        )
    return _client


_CLASSIFY_TOOL_NAME = "record_classification"

_CLASSIFY_PROMPT = """This is a scanned BD Care service report for one flow cytometer in a fixed \
fleet of three models. Identify two things and report a confidence (0 to 1) for each \
independently — they are not the same call.

1. Which instrument model this document is for. Look for the "Installed Product" or \
"System" field, which prints a code and model name (e.g. "648282B3 - ARIA III ACDU \
6B/3R/3V" is a FACSAria III; "665158 - FACSDiscover S8 ..." is a FACSDiscover S8). \
Only choose from the allowed options.

2. What kind of service visit this is. The most reliable signal is the "Work Order \
Task Code" field: a code starting T113 ("Repair / Troubleshooting Visit") means \
repair; a code starting T111 ("Preventive Maintenance") means preventive_maintenance; \
anything referencing CS&T/QC calibration with no fault or PM-kit language means \
calibration. Repair, PM, and calibration visits otherwise share the same generic \
form layout, so this is a genuinely harder call than #1 — give it a lower confidence \
when the task code is unclear or missing rather than guessing high.

Give confidence scores that reflect real uncertainty. A clean, legible, unambiguous \
read deserves something like 0.9-0.98. Anything you had to infer rather than read \
directly, or where the document is ambiguous between two categories, deserves \
meaningfully lower — do not default to a high number out of politeness."""


def _stable_unit(*parts: str) -> float:
    """A float in [0, 1), stable for the same inputs — stands in for "model
    confidence" without needing an actual model call."""
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def _live_classify(db: Session, attachment: Attachment, instruments: list[Instrument]) -> tuple[ClassificationGuess, ClassificationGuess]:
    """The real Claude vision call. Sends the scanned PDF as a `document`
    content block (native multi-page PDF support — see SL-TDD-001 §1) and
    forces a tool call so the model's answer comes back as validated JSON
    rather than free text to parse (§4: "returns ... a confidence for
    each")."""
    pdf_bytes = Path(attachment.file_path).read_bytes()
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("ascii")
    model_options = sorted({i.model for i in instruments})

    tool = {
        "name": _CLASSIFY_TOOL_NAME,
        "description": "Record the classified instrument model and report type for this scanned service document.",
        "input_schema": {
            "type": "object",
            "properties": {
                "instrument_model": {"type": "string", "enum": model_options},
                "instrument_confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "report_type": {"type": "string", "enum": [rt.value for rt in ReportType]},
                "report_type_confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["instrument_model", "instrument_confidence", "report_type", "report_type_confidence"],
        },
    }

    # §-none-yet: there's no APM/request tracing in this project, so this
    # timer is the only record of how long a live Claude call actually took
    # — worth having on both the success and failure path (a slow classify
    # is a real "why is the job stuck" question during a demo).
    call_started = time.perf_counter()
    try:
        response = _get_client().messages.create(
            model=settings.anthropic_model,
            max_tokens=1024,
            tools=[tool],
            tool_choice={"type": "tool", "name": _CLASSIFY_TOOL_NAME},
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": pdf_b64}},
                        {"type": "text", "text": _CLASSIFY_PROMPT},
                    ],
                }
            ],
        )
    except anthropic.AuthenticationError as e:
        # Not retried by the SDK (a bad key won't fix itself) — worth its own
        # message since "check ANTHROPIC_API_KEY" is a much faster diagnosis
        # than the generic APIError message below. Logged here (not just
        # raised) because the router/worker only ever store str(e) on the
        # job row — without this, an auth failure was previously invisible
        # anywhere a human would actually look while debugging live.
        logger.exception(
            "Claude API authentication failed classifying attachment %s after %.2fs",
            attachment.file_path,
            time.perf_counter() - call_started,
        )
        raise ClassificationError(f"Claude API authentication failed — check ANTHROPIC_API_KEY: {e}") from e
    except anthropic.APIError as e:
        # Covers everything else the SDK can raise for this call (connection
        # errors, timeouts, rate limits, 5xx) — already retried internally
        # up to settings.anthropic_max_retries before landing here, so the
        # elapsed time here includes all of those retries, not just one shot.
        logger.exception(
            "Claude API request failed classifying attachment %s after %.2fs",
            attachment.file_path,
            time.perf_counter() - call_started,
        )
        raise ClassificationError(f"Claude API request failed during classification: {e}") from e

    usage = getattr(response, "usage", None)
    logger.info(
        "Claude classify API call for attachment %s completed in %.2fs (input_tokens=%s, output_tokens=%s)",
        attachment.file_path,
        time.perf_counter() - call_started,
        getattr(usage, "input_tokens", "?"),
        getattr(usage, "output_tokens", "?"),
    )

    try:
        tool_use = next(block for block in response.content if block.type == "tool_use")
    except StopIteration as e:
        logger.error(
            "Claude returned no tool_use block classifying attachment %s (got block types: %s)",
            attachment.file_path,
            [getattr(block, "type", "?") for block in response.content],
        )
        raise ClassificationError(
            "Claude did not return the expected tool call for classification (no tool_use block in the response)"
        ) from e

    data = tool_use.input
    try:
        instrument_guess = ClassificationGuess(value=data["instrument_model"], confidence=float(data["instrument_confidence"]))
        type_guess = ClassificationGuess(value=data["report_type"], confidence=float(data["report_type_confidence"]))
    except (KeyError, TypeError, ValueError) as e:
        # Tool-use input isn't strictly validated against the schema (see
        # extraction.py's flat-schema comment for a live example of this),
        # so a missing key or an unparseable confidence is a real, seen-in-
        # practice failure mode, not just defensive paranoia.
        logger.error(
            "Claude's classification response for attachment %s was missing or malformed fields: %s (raw tool input: %r)",
            attachment.file_path,
            e,
            data,
        )
        raise ClassificationError(f"Claude's classification response was missing or malformed fields: {e}") from e

    return instrument_guess, type_guess


def _stub_classify(attachment: Attachment, instruments: list[Instrument]) -> tuple[ClassificationGuess, ClassificationGuess]:
    lower_path = attachment.file_path.lower()
    if any(marker in lower_path for marker in _SAMPLE_MARKERS):
        # Reproduces the real BD Care EU Work Order Service Report case
        # discussed in spec §4: instrument ID is a confident read, report
        # type is the harder call because repair/PM/calibration share one
        # generic layout.
        instrument = next((i for i in instruments if i.model == "LSRFortessa"), instruments[0])
        instrument_guess = ClassificationGuess(value=instrument.model, confidence=0.96)
        type_guess = ClassificationGuess(value=ReportType.repair.value, confidence=0.58)
    else:
        # Deterministic "confident" guess for any other upload: pick an
        # instrument and report type from a stable hash of the file path
        # rather than randomly, so re-classifying the same attachment always
        # returns the same answer.
        instrument = instruments[int(_stable_unit(attachment.file_path, "instrument") * len(instruments))]
        report_types = list(ReportType)
        report_type = report_types[int(_stable_unit(attachment.file_path, "report_type") * len(report_types))]
        instrument_guess = ClassificationGuess(
            value=instrument.model, confidence=round(0.9 + 0.09 * _stable_unit(attachment.file_path, "ic"), 2)
        )
        type_guess = ClassificationGuess(
            value=report_type.value, confidence=round(0.86 + 0.12 * _stable_unit(attachment.file_path, "tc"), 2)
        )
    return instrument_guess, type_guess


def classify(db: Session, attachment: Attachment) -> ClassificationResult:
    instruments = db.query(Instrument).order_by(Instrument.serial_number).all()
    if not instruments:
        raise RuntimeError("No instruments registered — seed the instrument fleet before classifying (see app/seed_instruments.py).")

    if settings.use_live_claude:
        instrument_guess, type_guess = _live_classify(db, attachment, instruments)
    else:
        instrument_guess, type_guess = _stub_classify(attachment, instruments)

    resolved_template: ReportTemplate | None = None
    resolved_instrument_id = None
    # The fixed MVP fleet (§1) has exactly one instrument per model, so the
    # first match is the only match; this would need a real disambiguation
    # step (serial number, most likely) if the fleet ever grows past that.
    matched_instrument = next((i for i in instruments if i.model == instrument_guess.value), None)
    if (
        matched_instrument is not None
        and instrument_guess.confidence >= settings.classification_confidence_threshold
        and type_guess.confidence >= settings.classification_confidence_threshold
    ):
        resolved_template = resolve_template(
            db, instrument_type="facs", report_type=type_guess.value, model=instrument_guess.value
        )
        resolved_instrument_id = matched_instrument.id

    return ClassificationResult(
        instrument=instrument_guess,
        report_type=type_guess,
        resolved_template_id=resolved_template.id if resolved_template else None,
        resolved_instrument_id=resolved_instrument_id,
    )
