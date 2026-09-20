"""One-shot database reset for the frontend's Playwright E2E suite
(frontend/playwright.config.ts starts this before booting its own backend
instance).

Deliberately separate from tests/conftest.py's pytest fixtures: that database
(service_ledger_test) gets its schema created and dropped per pytest
session, so its tables may or may not exist at any given moment depending on
whether a pytest run is currently in progress — not something a second,
independently-run test suite should depend on. This script targets its own
database (service_ledger_e2e by convention, set via DATABASE_URL) and is
idempotent either way: create_all only creates what's missing, and the
TRUNCATE is a no-op on empty tables.

After this runs, app.main's own startup lifespan reseeds the instrument
fleet and report templates automatically the moment uvicorn boots against the
now-empty database — this script only needs to clear rows, not restore them.
"""
from __future__ import annotations

from sqlalchemy import create_engine, text

from app import models  # noqa: F401 — import-for-side-effect: registers every
# table on Base.metadata before create_all runs below. Base itself (app/db.py)
# declares no tables on its own; without this import metadata.create_all is a
# silent no-op against an empty registry, same trap tests/conftest.py avoids
# by importing app.main (which transitively imports every router, and with it
# every model).
from app.config import get_settings
from app.db import Base


def main() -> None:
    settings = get_settings()
    engine = create_engine(settings.database_url, future=True)
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        for table in ("extraction_jobs", "attachments", "reports", "report_templates", "instruments"):
            conn.execute(text(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE"))
    print(f"Reset {settings.database_url.split('@')[-1]} for the E2E suite.")


if __name__ == "__main__":
    main()
