"""A document read's result type and the pure helpers that interpret it (re-exported by classification.py)."""
from __future__ import annotations
import re
from typing import Literal, NamedTuple

from sqlalchemy.orm import Session

from app.models import Instrument, ReportType
from app.schemas import ClassificationGuess
from app.services.manufacturers import is_maker


_INVISIBLE = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u200e\u200f\u2060\ufeff"))


def _clean(value: object) -> str | None:
    """A text the model returned, with invisible characters and surrounding
    space removed; None when nothing is left. (A live read once returned a lone
    zero-width space for "no work-order number".)"""
    if not isinstance(value, str):
        return None
    cleaned = value.translate(_INVISIBLE).strip()
    return cleaned or None


class DocumentRead(NamedTuple):
    """Everything one classification read of a document produced. The first
    three positions are the original (instrument, report type, serial) triple;
    a plain 3-tuple still converts via `DocumentRead(*triple)`."""

    instrument: ClassificationGuess
    report_type: ClassificationGuess
    serial: ClassificationGuess | None
    work_order_number: str | None = None
    # "none": no task code was read and nothing else says what kind of visit
    # this is, so the report type below is a placeholder with zero confidence.
    report_type_source: Literal["task_code", "model", "none"] = "model"
    # Who read the document: "model" = Claude, "text_layer" = the PDF's own
    # text parsed in code (services/text_reader.py, no API key needed),
    # "stub" = the deterministic demo stand-in for a document with no text.
    reader: Literal["model", "text_layer", "stub"] = "model"
    # Read off a document from another company's form (a translated Hebrew
    # service report, say): who issued the form, the instrument's maker as the
    # model could tell it, whether that instrument is in the fleet at all, and
    # a note when the visit fits a second report type.
    issuer: str | None = None
    detected_manufacturer: str | None = None
    maker_in_fleet: bool = True
    report_type_note: str | None = None
    # The instrument's model name as printed or as the model could tell it
    # (e.g. "Cytek Aurora"), so the screen can offer to add it to the fleet.
    detected_model: str | None = None


# What a printed task code says about the kind of visit. A task code is one maker's
# own coding scheme, so the table is kept per maker (by a name the maker is known by,
# see services/manufacturers.is_maker) and used only for that maker's documents: another
# maker's "T113" must not be read as BD's repair code. Only codes whose meaning is
# documented are listed; any other code falls back to the model's own judgment rather
# than being guessed at.
_TASK_CODE_REPORT_TYPES_BY_MAKER: dict[str, dict[str, ReportType]] = {
    "BD": {
        "T111": ReportType.preventive_maintenance,
        "T107": ReportType.installation_upgrade,
        "T113": ReportType.repair,
    },
}
DEFAULT_TASK_CODE_SCHEME = "BD"


def task_code_scheme(db: Session, maker_text: str | None) -> str | None:
    """The task-code scheme (a key of the table above) a document from this maker uses,
    or None when the maker has none listed or is not known."""
    return next((name for name in _TASK_CODE_REPORT_TYPES_BY_MAKER if is_maker(db, maker_text, name)), None)


def report_type_from_task_code(code: object, scheme: str | None = DEFAULT_TASK_CODE_SCHEME) -> ReportType | None:
    """The report type a printed task code stands for in `scheme` (one maker's coding),
    or None when there is no scheme, or the code is missing, unparseable, or not one we
    know the meaning of. `scheme` defaults to BD's, the only one listed."""
    table = _TASK_CODE_REPORT_TYPES_BY_MAKER.get(scheme) if scheme else None
    if not table or not isinstance(code, str):
        return None
    match = re.match(r"\s*(T\d{3})", code.upper())
    return table.get(match.group(1)) if match else None


# What a document prints when the instrument has no serial number.
_NO_SERIAL_WORDS = {"n/a", "na", "none", "null", "unknown", "-", "--"}


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
