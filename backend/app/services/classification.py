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

import logging
import re
from typing import Literal, NamedTuple

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Attachment, Instrument, ReportTemplate, ReportType
from app.schemas import ClassificationGuess, ClassificationResult
from app.services.claude_client import (
    is_sample_document as _is_sample_document,
    call_claude_tool,
    extract_tool_use,
    get_client as _get_client,
    stable_unit as _stable_unit,
)
from app.services.duplicates import find_duplicate_report_ids, normalize_work_order
from app.services.errors import ClassificationError
from app.services.documents import UnsupportedDocumentError, claude_content_block
from app.services.templates import resolve_template

logger = logging.getLogger("app.services.classification")
settings = get_settings()

_CLASSIFY_TOOL_NAME = "record_classification"

_CLASSIFY_PROMPT = """This is a scanned BD Care service report for one flow cytometer in a fixed \
fleet of three models. Identify three things and report a confidence (0 to 1) for each \
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
when the task code is unclear or missing rather than guessing high. Separately, copy \
the Work Order Task Code exactly as printed (e.g. "T113") into `task_code` with a \
`task_code_confidence`; the application maps the code to a report type itself, so \
accuracy of the characters matters more than your interpretation of them. If there \
is no task code, return an empty string with confidence 0.

3. The instrument's serial number, exactly as printed in the "Installed Product" block \
(its "Serial/Lot Number" line, e.g. "MP6651580000057"). Ignore the "Serial/Lot Number: \
N/A" line under the SYSTEM column, which is not the instrument's. Copy the characters \
exactly; never guess or complete a character you cannot read — give a lower confidence \
instead. If the Installed Product has no serial number, or it is printed as N/A, return \
an empty string with confidence 0.

4. The work-order number, exactly as printed (e.g. "WO-04587090"), in \
`work_order_number`; an empty string if the document shows none.

Give confidence scores that reflect real uncertainty. A clean, legible, unambiguous \
read deserves something like 0.9-0.98. Anything you had to infer rather than read \
directly, or where the document is ambiguous between two categories, deserves \
meaningfully lower — do not default to a high number out of politeness."""


class DocumentRead(NamedTuple):
    """Everything one classification read of a document produced. The first
    three positions are the original (instrument, report type, serial) triple;
    a plain 3-tuple still converts via `DocumentRead(*triple)`."""

    instrument: ClassificationGuess
    report_type: ClassificationGuess
    serial: ClassificationGuess | None
    work_order_number: str | None = None
    report_type_source: Literal["task_code", "model"] = "model"


# What the Work Order Task Code says about the kind of visit. Only codes whose
# meaning is documented are listed; any other code falls back to the model's
# own judgment rather than being guessed at.
_TASK_CODE_REPORT_TYPES = {
    "T111": ReportType.preventive_maintenance,
    "T113": ReportType.repair,
}


def report_type_from_task_code(code: object) -> ReportType | None:
    """The report type a printed task code stands for, or None when the code
    is missing, unparseable, or not one we know the meaning of."""
    if not isinstance(code, str):
        return None
    match = re.match(r"\s*(T\d{3})", code.upper())
    return _TASK_CODE_REPORT_TYPES.get(match.group(1)) if match else None


def _apply_task_code(
    type_guess: ClassificationGuess, data: dict, attachment_path: str
) -> tuple[ClassificationGuess, Literal["task_code", "model"]]:
    """Prefer the task code over the model's judgment of the visit type.

    Reading a code is a lookup; deciding whether a generic form is a repair or
    a PM is a judgment, and the one that was scoring 0.58 on the sample
    document. When a known code was read confidently it decides the type, with
    the confidence of the *read*. A code read with doubt is ignored — the
    model's guess stands, so the report still falls through to manual
    confirmation when that guess is itself unsure."""
    mapped = report_type_from_task_code(data.get("task_code"))
    if mapped is None:
        return type_guess, "model"
    try:
        confidence = min(max(float(data.get("task_code_confidence", 0.0)), 0.0), 1.0)
    except (TypeError, ValueError):
        confidence = 0.0
    if confidence < settings.classification_confidence_threshold:
        return type_guess, "model"
    if mapped.value == type_guess.value:
        # Two independent routes agree: at least as sure as the surer of them.
        confidence = max(confidence, type_guess.confidence)
    else:
        logger.info(
            "Task code %r says %s but the model said %s (%.2f) for attachment %s — using the task code",
            data.get("task_code"),
            mapped.value,
            type_guess.value,
            type_guess.confidence,
            attachment_path,
        )
    return ClassificationGuess(value=mapped.value, confidence=confidence), "task_code"


def _live_classify(
    db: Session, attachment: Attachment, instruments: list[Instrument]
) -> DocumentRead:
    """The real Claude vision call. Sends the scanned PDF as a `document`
    content block (native multi-page PDF support — see SL-TDD-001 §1) and
    forces a tool call so the model's answer comes back as validated JSON
    rather than free text to parse (§4: "returns ... a confidence for
    each")."""
    try:
        document_block = claude_content_block(attachment.file_path)
    except UnsupportedDocumentError as e:
        raise ClassificationError(str(e)) from e
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
                "instrument_serial": {"type": "string", "description": "Serial number as printed, or empty if none"},
                "instrument_serial_confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "task_code": {"type": "string", "description": "Work Order Task Code as printed (e.g. T113), or empty"},
                "task_code_confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "work_order_number": {"type": "string", "description": "Work-order number as printed, or empty"},
            },
            "required": [
                "instrument_model",
                "instrument_confidence",
                "report_type",
                "report_type_confidence",
                "instrument_serial",
                "instrument_serial_confidence",
                "task_code",
                "task_code_confidence",
                "work_order_number",
            ],
        },
    }

    response = call_claude_tool(
        client=_get_client(),
        request_kwargs=dict(
            model=settings.anthropic_model,
            max_tokens=1024,
            tools=[tool],
            tool_choice={"type": "tool", "name": _CLASSIFY_TOOL_NAME},
            messages=[
                {
                    "role": "user",
                    "content": [
                        document_block,
                        {"type": "text", "text": _CLASSIFY_PROMPT},
                    ],
                }
            ],
        ),
        error_cls=ClassificationError,
        logger=logger,
        attachment_path=attachment.file_path,
        verb="classify",
        gerund="classifying",
        noun="classification",
    )

    tool_use = extract_tool_use(
        response,
        error_cls=ClassificationError,
        logger=logger,
        attachment_path=attachment.file_path,
        gerund="classifying",
        noun="classification",
    )

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

    type_guess, type_source = _apply_task_code(type_guess, data, attachment.file_path)
    work_order = data.get("work_order_number")
    return DocumentRead(
        instrument_guess,
        type_guess,
        _parse_serial_read(data, attachment.file_path),
        work_order.strip() if isinstance(work_order, str) and work_order.strip() else None,
        type_source,
    )


# What a document prints when the instrument has no serial number.
_NO_SERIAL_WORDS = {"n/a", "na", "none", "null", "unknown", "-", "--"}


def _parse_serial_read(data: dict, attachment_path: str) -> ClassificationGuess | None:
    """The serial Claude read, or None when it found none. The serial fields
    are optional in what we accept (an older or sloppier answer without them
    is still a valid classification), and a malformed confidence only means
    "unsure", never a failed classification."""
    value = data.get("instrument_serial")
    if not isinstance(value, str) or not value.strip() or value.strip().lower() in _NO_SERIAL_WORDS:
        return None
    try:
        confidence = float(data.get("instrument_serial_confidence", 0.0))
    except (TypeError, ValueError):
        logger.warning("Non-numeric serial confidence on attachment %s — treating as 0.0", attachment_path)
        confidence = 0.0
    return ClassificationGuess(value=value.strip(), confidence=min(max(confidence, 0.0), 1.0))


def _normalize_serial(serial: str) -> str:
    """Case, spaces, hyphens and other punctuation vary between how a serial
    is printed and how it was typed into the Instruments tab."""
    return "".join(ch for ch in serial.upper() if ch.isalnum())


def match_serial(serial: ClassificationGuess | None, instruments: list[Instrument]) -> Instrument | None:
    """The one instrument whose serial equals the one read from the document.
    None when no serial was read, nothing matches, or — rarely, since only the
    exact serial is unique in the database — two serials differ only by
    punctuation or case and the match would be a guess."""
    if serial is None:
        return None
    wanted = _normalize_serial(serial.value)
    if not wanted:
        return None
    matches = [i for i in instruments if _normalize_serial(i.serial_number) == wanted]
    return matches[0] if len(matches) == 1 else None


def _stub_serial_read(file_path: str, instruments: list[Instrument]) -> ClassificationGuess | None:
    """The stub "reads" a serial only when the uploaded file's own name contains
    a fleet instrument's serial (e.g. scan_A47291.pdf), so serial matching can
    be exercised by choosing a file name and every other stub upload behaves
    exactly as before. Longest serials first, so one that contains another is
    not shadowed by it."""
    name = file_path.replace("\\", "/").rsplit("/", 1)[-1].upper()
    for instrument in sorted(instruments, key=lambda i: len(i.serial_number), reverse=True):
        if len(instrument.serial_number) >= 4 and instrument.serial_number.upper() in name:
            return ClassificationGuess(value=instrument.serial_number, confidence=0.95)
    return None


def _stub_work_order(file_path: str) -> str | None:
    """The stub "reads" a work-order number only when the uploaded file's own
    name contains one (e.g. scan_WO-04587090.pdf), mirroring _stub_serial_read,
    so duplicate detection can be exercised by choosing a file name."""
    name = file_path.replace("\\", "/").rsplit("/", 1)[-1]
    match = re.search(r"WO[-_ ]?\d{5,}", name, re.IGNORECASE)
    return match.group(0) if match else None


def _stub_classify(
    attachment: Attachment, instruments: list[Instrument]
) -> DocumentRead:
    if _is_sample_document(attachment.file_path):
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
        # A file named after an instrument's serial number is "read" as that
        # instrument (see _stub_serial_read), as a real read of its serial
        # would be, so the model guess agrees with it.
        serial_instrument = match_serial(_stub_serial_read(attachment.file_path, instruments), instruments)
        if serial_instrument is not None:
            instrument = serial_instrument
        report_types = list(ReportType)
        report_type = report_types[int(_stable_unit(attachment.file_path, "report_type") * len(report_types))]
        instrument_guess = ClassificationGuess(
            value=instrument.model, confidence=round(0.9 + 0.09 * _stable_unit(attachment.file_path, "ic"), 2)
        )
        type_guess = ClassificationGuess(
            value=report_type.value, confidence=round(0.86 + 0.12 * _stable_unit(attachment.file_path, "tc"), 2)
        )
    return DocumentRead(
        instrument_guess,
        type_guess,
        _stub_serial_read(attachment.file_path, instruments),
        _stub_work_order(attachment.file_path),
    )


def classify(db: Session, attachment: Attachment) -> ClassificationResult:
    instruments = db.query(Instrument).order_by(Instrument.serial_number).all()
    if not instruments:
        raise RuntimeError("No instruments registered — seed the instrument fleet before classifying (see app/seed_instruments.py).")

    # DocumentRead(*...) so a plain (instrument, type, serial) triple — what
    # these two functions returned before — is still accepted.
    if settings.use_live_claude:
        document = DocumentRead(*_live_classify(db, attachment, instruments))
    else:
        document = DocumentRead(*_stub_classify(attachment, instruments))
    instrument_guess, type_guess, serial_read = document.instrument, document.report_type, document.serial

    resolved_template: ReportTemplate | None = None
    resolved_instrument_id = None
    # The seeded MVP fleet (§1) has one instrument per model, but nothing
    # enforces that — the Instruments tab can add a second unit of an
    # existing model (only serial_number is unique). A model alone cannot tell
    # same-model units apart, so with several of them and no usable serial the
    # report is not auto-resolved at all: it falls through to the manual
    # confirm step where the technician picks the unit by serial number.
    # Picking the first match here used to silently attribute the report to
    # whichever same-model unit sorted first.
    # The serial number printed on the document is what does tell two units of
    # one model apart: when it matches exactly one fleet instrument, that is
    # the instrument. See _resolve_instrument below for the rules.
    matching_instruments = [i for i in instruments if i.model == instrument_guess.value]
    only_of_model = matching_instruments[0] if len(matching_instruments) == 1 else None
    serial_instrument = match_serial(serial_read, instruments)
    if serial_read is None:
        serial_match = "not_read"
    elif serial_instrument is None:
        serial_match = "not_found"
    elif serial_instrument.model != instrument_guess.value:
        serial_match = "model_conflict"
    else:
        serial_match = "matched"

    if serial_match == "matched" and serial_read.confidence >= settings.classification_confidence_threshold:
        matched_instrument = serial_instrument
    elif serial_match == "model_conflict":
        # The serial says one model and the document's model line another: one
        # of the two reads is wrong, so don't pick for the technician.
        matched_instrument = None
    else:
        # No usable serial (not read, not in the fleet, or read with low
        # confidence): fall back to the model alone, which is only enough when
        # a single unit has that model.
        matched_instrument = only_of_model
    if (
        matched_instrument is not None
        and instrument_guess.confidence >= settings.classification_confidence_threshold
        and type_guess.confidence >= settings.classification_confidence_threshold
    ):
        resolved_template = resolve_template(
            db, instrument_type="facs", report_type=type_guess.value, model=instrument_guess.value
        )
        # Only report the instrument as resolved when a template was also
        # found — ClassificationResult's own docstring says these two are
        # set together ("present only when ... a template could be resolved
        # automatically"). Templates are user-deletable (DELETE
        # /report-templates/{id}), so resolve_template() returning None here
        # is a real, reachable case, not just defensive: without this guard,
        # a confident classification whose template row was since deleted
        # reported a resolved instrument with no resolved template, which
        # worker._run_classify_job correctly ignores (it requires both) but
        # which misleads any caller reading the job's classification payload
        # directly as if partial auto-resolution had occurred.
        if resolved_template is not None:
            resolved_instrument_id = matched_instrument.id

    suggested = serial_instrument if serial_match in ("matched", "model_conflict") else only_of_model
    return ClassificationResult(
        instrument=instrument_guess,
        report_type=type_guess,
        instrument_serial=serial_read,
        serial_match=serial_match,
        suggested_instrument_id=suggested.id if suggested else None,
        resolved_template_id=resolved_template.id if resolved_template else None,
        resolved_instrument_id=resolved_instrument_id,
        report_type_source=document.report_type_source,
        work_order_number=document.work_order_number,
        duplicate_report_ids=find_duplicate_report_ids(
            db, attachment, normalize_work_order(document.work_order_number)
        ),
    )
