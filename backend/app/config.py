"""Central settings object, loaded from environment / .env (see .env.example).

Every tunable named in the architecture spec (confidence thresholds, storage
location, the live-Claude switch) lives here rather than scattered through the
codebase, so §4/§12's open questions have exactly one place to answer them.
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = (
        "postgresql+psycopg2://service_ledger:service_ledger_dev@localhost:5432/service_ledger"
    )

    attachment_storage_dir: str = "./storage/attachments"

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

    use_live_claude: bool = False
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

    @property
    def attachment_storage_path(self) -> Path:
        path = Path(self.attachment_storage_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
