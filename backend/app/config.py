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
        "postgresql+psycopg2://calibration_ledger:calibration_ledger_dev@localhost:5432/calibration_ledger"
    )

    attachment_storage_dir: str = "./storage/attachments"

    # §4: fields below this confidence are flagged for mandatory review.
    field_confidence_threshold: float = 0.7
    # §12 open question, defaulted here: classification gets its own (stricter)
    # threshold because a wrong report-type guess is the costliest failure in
    # the pipeline, not just another field.
    classification_confidence_threshold: float = 0.85

    use_live_claude: bool = False
    anthropic_api_key: str = ""

    @property
    def attachment_storage_path(self) -> Path:
        path = Path(self.attachment_storage_dir)
        path.mkdir(parents=True, exist_ok=True)
        return path


@lru_cache
def get_settings() -> Settings:
    return Settings()
