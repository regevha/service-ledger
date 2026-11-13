"""SQLAlchemy models — a direct implementation of the spec's §5 data model.

Table shapes, column names, and nullability all mirror SL-ARCH-001 §5 exactly:
`reports.instrument_id` / `template_id` are nullable because document-first
intake (§4) resolves them after classification rather than at creation, and
`extraction_jobs.classification` is a separate JSONB column from
`field_confidences` because it gates which template the rest of the job runs
against. See the spec (published Artifact) for the full rationale behind each
of these choices — this file only encodes the decisions, it doesn't re-argue them.
"""

# Pure split of the former models.py: every name that was importable from
# `app.models` is re-exported here, so `from app import models` and
# `from app.models import X` keep working unchanged. All the model modules
# are imported (in dependency order) so every class is registered on
# `Base.metadata` and the string-named relationships resolve.
from app.db import Base  # noqa: F401

from .enums import (  # noqa: F401
    DEFAULT_INSTRUMENT_TYPE_KEY,
    ExtractionJobKind,
    ExtractionJobStatus,
    InstrumentStatus,
    ReportStatus,
    ReportType,
    TranslationStatus,
    _uuid_pk,
)
from .instruments import (  # noqa: F401
    PLACE_KINDS,
    Instrument,
    InstrumentModel,
    InstrumentType,
    Manufacturer,
    Place,
)
from .reports import Attachment, Report, ReportTemplate, report_chronological_order  # noqa: F401
from .intake import (  # noqa: F401
    IntakeAllowEntry,
    IntakeAllowKind,
    IntakeFile,
    IntakeFileOutcome,
    IntakeMessage,
    IntakeMessageOutcome,
    IntakeReadState,
    IntakeReplyStatus,
    ReportSource,
    ReportSourceChannel,
)
from .jobs import ExtractionJob, SearchModelCall, Translation  # noqa: F401
from .saved_filters import SavedReportFilter  # noqa: F401
from .field_aliases import FieldAliasGroup, FieldAliasName  # noqa: F401


# Importing the search module registers the before_flush listener that keeps
# Report.search_text current (see services/report_search.py). It lives at the
# bottom because that module imports this one.
from app.services import instrument_models, places, report_search  # noqa: E402,F401
