"""Classification service — §4 step 3.

`classify()` is the one function a real Claude vision call replaces later.
Its signature and return shape (a guess + confidence for instrument, a guess
+ confidence for report type) are the actual contract the rest of the app is
built against, so swapping the stub body for a live API call touches only
this file — no router, model, or schema changes required.

The stub is deterministic (seeded from the attachment's id/path) rather than
randomly noisy, so a demo run is reproducible. It also special-cases the real
sample BD Care Work Order used throughout the spec: that document genuinely
has a confident instrument read and a borderline report-type read (§4's
"same generic layout for a repair, a PM visit, or a calibration" point), so
the stub reproduces that exact asymmetry rather than pretending every
document is easy.
"""
from __future__ import annotations

import hashlib

from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Attachment, Instrument, ReportTemplate, ReportType
from app.schemas import ClassificationGuess, ClassificationResult
from app.services.templates import resolve_template

settings = get_settings()

_SAMPLE_MARKERS = ("wo-04587090", "sample", "work_order", "work-order")


def _stable_unit(*parts: str) -> float:
    """A float in [0, 1), stable for the same inputs — stands in for "model
    confidence" without needing an actual model call."""
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def classify(db: Session, attachment: Attachment) -> ClassificationResult:
    lower_path = attachment.file_path.lower()
    instruments = db.query(Instrument).order_by(Instrument.serial_number).all()
    if not instruments:
        raise RuntimeError("No instruments registered — seed the instrument fleet before classifying (see app/seed_instruments.py).")

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

    resolved_template: ReportTemplate | None = None
    resolved_instrument_id = None
    if (
        instrument_guess.confidence >= settings.classification_confidence_threshold
        and type_guess.confidence >= settings.classification_confidence_threshold
    ):
        resolved_template = resolve_template(
            db, instrument_type="facs", report_type=type_guess.value, model=instrument_guess.value
        )
        resolved_instrument_id = instrument.id

    return ClassificationResult(
        instrument=instrument_guess,
        report_type=type_guess,
        resolved_template_id=resolved_template.id if resolved_template else None,
        resolved_instrument_id=resolved_instrument_id,
    )
