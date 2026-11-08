"""Enums and small helpers shared by the models."""
import enum
import uuid

from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

# The key of the instrument type new instruments, models and templates get when none is
# given (shown as "Flow cytometer"). The one place the key is written; the API reports it
# as `is_default` on GET /instrument-types so the screens do not repeat it.
DEFAULT_INSTRUMENT_TYPE_KEY = "flow_cytometer"


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class InstrumentStatus(str, enum.Enum):
    """Not specified in the spec's data-model table — a reasonable MVP default,
    flagged here (rather than silently assumed) so it's easy to spot and revise."""

    active = "active"
    maintenance = "maintenance"
    retired = "retired"


class ReportStatus(str, enum.Enum):
    """Exactly the five values named in §5: draft -> classified -> extracted ->
    in_review -> finalized."""

    draft = "draft"
    classified = "classified"
    extracted = "extracted"
    in_review = "in_review"
    finalized = "finalized"


class ReportType(str, enum.Enum):
    repair = "repair"
    preventive_maintenance = "preventive_maintenance"
    # Installing options or hardware, or upgrading software/firmware (BD task
    # code T107). Added after a real software-upgrade report fit none of the
    # first three types.
    installation_upgrade = "installation_upgrade"


class ExtractionJobStatus(str, enum.Enum):
    """Not enumerated explicitly in §5 ("status") — the obvious lifecycle for a
    background job, kept minimal on purpose."""

    pending = "pending"
    classifying = "classifying"
    extracting = "extracting"
    translating = "translating"
    awaiting_approval = "awaiting_approval"
    succeeded = "succeeded"
    failed = "failed"


class ExtractionJobKind(str, enum.Enum):
    """Which half of §4's pipeline this job runs. Not a spec-named column —
    the spec's job table (§5) describes "one classify-then-extract attempt"
    in prose, but the actual endpoints (§9) submit classify and extract as
    two separate calls with a manual-confirm checkpoint possibly in between
    (§4/§6), so each call gets its own job row rather than one row trying to
    span a human-in-the-loop gap. `app.worker` reads this to know which
    service function to run for a `pending` row."""

    classify = "classify"
    extract = "extract"
    # Hebrew (or other foreign-language) documents are translated to English
    # first and a person reviews the result before classify/extract run.
    translate = "translate"


class TranslationStatus(str, enum.Enum):
    """Life of one translation record. A person always reviews a translation
    (`pending_review` -> `accepted`); `discarded` means the original is used as
    it is today; `superseded` is a replaced translation kept as history;
    `not_needed` records that the document was checked and is not Hebrew."""

    pending_review = "pending_review"
    accepted = "accepted"
    discarded = "discarded"
    superseded = "superseded"
    not_needed = "not_needed"
