"""Central settings object, loaded from environment / .env (see .env.example).

Every tunable named in the architecture spec (confidence thresholds, storage
location, the live-Claude switch) lives here rather than scattered through the
codebase, so §4/§12's open questions have exactly one place to answer them.
"""
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = (
        "postgresql+psycopg2://service_ledger:service_ledger_dev@localhost:5432/service_ledger"
    )

    attachment_storage_dir: str = "./storage/attachments"

    # One shared password in front of the whole app (HTTP Basic: any user name,
    # this password). Empty means no gate, as in development. When it is set it
    # must be long enough not to be guessed; see app/shared_password.py.
    shared_password: str = ""
    # Folder with the built frontend (npm run build -> frontend/dist). Empty
    # means the API does not serve the page (development uses the Vite server).
    frontend_dist_dir: str = ""
    # Extra browser origins allowed to call the API, comma separated. Only used when
    # the API serves the built frontend itself (FRONTEND_DIST_DIR set): the page and
    # the API then share one origin and no other site needs access, so the default
    # is none. Without FRONTEND_DIST_DIR (development) every origin is allowed.
    cors_allowed_origins: str = ""

    # Claude call debug log (docs: claude/proposal-debug-log.md). Off by default and
    # switched on only by the project owner, by this environment setting (never in the
    # app): "light" records each call without the prompt text or tool schema, "deep"
    # adds them. Documents are never stored, only their size and SHA-256. Files older
    # than `debug_claude_log_days` are deleted. Empty directory means a "debug-claude"
    # folder next to the attachments folder (so on the shared /data volume in Docker).
    debug_claude_log: str = ""
    debug_claude_log_dir: str = ""
    debug_claude_log_days: int = 7

    @field_validator("debug_claude_log_days")
    @classmethod
    def _debug_days_in_range(cls, value: int) -> int:
        if not 1 <= value <= 90:
            raise ValueError("DEBUG_CLAUDE_LOG_DAYS must be between 1 and 90")
        return value

    @field_validator("shared_password")
    @classmethod
    def _shared_password_not_trivial(cls, value: str) -> str:
        if value and len(value) < 12:
            raise ValueError("SHARED_PASSWORD must be at least 12 characters")
        return value

    # Spending limits on model-backed jobs, counted from the extraction_jobs table
    # (app/services/job_limits.py). A rolling 24 hours; 0 turns a limit off.
    daily_job_cap: int = 60
    max_failed_attempts_per_attachment: int = 3

    # Upload limits, checked before anything is written to disk. The Claude
    # API caps a whole request at about 32 MB and base64 adds a third on top
    # of the file, so a PDF over ~20 MB could never be sent; images have a
    # much smaller per-image limit (5 MB at the time of writing — check the
    # API docs if either changes).
    max_pdf_upload_bytes: int = 20 * 1024 * 1024
    max_image_upload_bytes: int = 5 * 1024 * 1024

    # §4: fields below this confidence are flagged for mandatory review.
    field_confidence_threshold: float = 0.7
    # §12 open question, defaulted here: classification gets its own (stricter)
    # threshold because a wrong report-type guess is the costliest failure in
    # the pipeline, not just another field.
    classification_confidence_threshold: float = 0.85

    # §3: "a single background worker process, polling a job table in
    # Postgres." How often app.worker checks for a new pending row when it
    # finds none — short enough that a technician waiting on the review
    # screen (§4/§6) doesn't notice the poll itself as added latency, long
    # enough not to hammer Postgres with an empty SELECT in the common case
    # (nothing pending) at single-user scale.
    worker_poll_interval_seconds: float = 0.5
    # A worker marks the job it is running as alive this often; a job in progress
    # with no beat for worker_stale_after_seconds is treated as orphaned.
    worker_heartbeat_interval_seconds: float = 15.0
    worker_stale_after_seconds: float = 120.0
    # How often a running worker looks for orphaned jobs (not just at startup).
    worker_recovery_interval_seconds: float = 60.0
    # Finished jobs older than this many days are deleted, except the newest finished job of
    # each kind per document (job_queue.prune_finished_jobs). 0 keeps everything. Kept above
    # the 24 hour windows the job caps count over.
    job_retention_days: int = 30
    worker_retention_interval_seconds: float = 3600.0

    # Debug aid: before each live Claude call the job stops and the intake screen
    # shows the exact prompt; the person presses Send or Cancel. Off by default.
    view_prompts: bool = False

    use_live_claude: bool = False
    # Stub mode only (ignored when use_live_claude is true). On (the default):
    # extraction reads the PDF's own text (services/text_extraction.py) and
    # leaves what it cannot read empty at confidence 0; a document with no text
    # layer fails with a message asking for an API key. Off: extraction invents
    # plausible values per field type, for demos and the e2e fixtures (the
    # test suite and Playwright set it to false).
    stub_extract_from_text: bool = True
    anthropic_api_key: str = ""
    # Was a literal "claude-sonnet-5" duplicated separately inside both
    # classification.py's and extraction.py's messages.create() calls, with
    # no setting backing it despite this module's own docstring — a model
    # bump meant editing two files and hoping both were caught. One place now.
    anthropic_model: str = "claude-sonnet-5"
    # Explicit rather than relying on the SDK's undocumented defaults: the
    # client already retries connection errors/408/409/429/5xx internally
    # with backoff up to this count before classify()/extract() ever see an
    # exception (see services/errors.py for what happens after retries are
    # exhausted). A vision call over a multi-page PDF is slower than a
    # typical text call, hence the generous timeout.
    anthropic_timeout_seconds: float = 90.0
    anthropic_max_retries: int = 2
    # Output limit of one extract call. A template with long tables (labor, parts,
    # detector values) needs room: a cut-off answer is refused, not half-used.
    extract_max_tokens: int = 8192
    # Give the extraction prompt the newest corrections people made to earlier readings of the same form
    # (services/read_accuracy.recent_corrections), so a mistake is not repeated. Live reading only.
    learn_from_corrections: bool = True
    learn_from_corrections_limit: int = 12

    # Model-backed search (docs: claude/proposal-model-backed-search.md). When a plain-words question leaves
    # words the rules could not place, one small call to a cheap model turns it into filters. Off by default,
    # and only ever used when use_live_claude is also on. Failure, timeout or the daily cap fall back to the rules.
    search_model_enabled: bool = False
    anthropic_search_model: str = "claude-haiku-5-5"
    search_model_timeout_seconds: float = 15.0
    search_model_max_tokens: int = 400
    # Questions sent to the model per UTC day, all users together. 0 = no limit.
    search_model_daily_cap: int = 500

    # Hebrew translation (docs: claude/proposal-hebrew-translation.md). A
    # document counts as Hebrew when more than this share of its letters are
    # Hebrew. A full three-page form needs a lot of output, and a vision call
    # over it runs about a minute, hence the larger limits than classify/extract.
    hebrew_letter_threshold: float = 0.2
    translate_max_tokens: int = 16000
    translate_timeout_seconds: float = 240.0

    @property
    def cors_origins(self) -> list[str]:
        if not self.frontend_dist_dir:
            return ["*"]
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip() and o.strip() != "*"]

    @property
    def stub_mode_warning(self) -> str | None:
        """Said at startup by the API and the worker when no real model is used, so
        invented demo values are not mistaken for a reading of the document."""
        if self.use_live_claude:
            return None
        return (
            "USE_LIVE_CLAUDE is off: documents are NOT read by the model. Classification and "
            "extraction return invented demo values. Set USE_LIVE_CLAUDE=true (and ANTHROPIC_API_KEY) "
            "for real use."
        )

    @property
    def attachment_storage_path(self) -> Path:
        path = Path(self.attachment_storage_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
