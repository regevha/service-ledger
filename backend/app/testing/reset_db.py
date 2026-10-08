"""One-shot database reset for the frontend's Playwright E2E suite
(frontend/playwright.config.ts starts this before booting its own backend
instance).

Deliberately separate from tests/conftest.py's pytest fixtures: that database
(service_ledger_test) gets its schema created and dropped per pytest
session, so its tables may or may not exist at any given moment depending on
whether a pytest run is currently in progress — not something a second,
independently-run test suite should depend on. This script targets its own
database (service_ledger_e2e by convention, set via DATABASE_URL) and is
idempotent either way.

It drops and recreates the schema rather than only truncating the rows:
create_all never alters what already exists, so a database created before a
new Postgres enum value or column was added (e.g. report_type gaining
installation_upgrade) would keep its old shape and the backend would fail on
the first insert that needs the new one. Everything in this database belongs
to the E2E suite, so rebuilding it each run costs nothing and cannot drift.

After this runs, app.main's own startup lifespan reseeds the instrument
fleet and report templates automatically the moment uvicorn boots against the
now-empty database — this script only needs to clear rows, not restore them.
"""
from __future__ import annotations

from sqlalchemy import create_engine

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
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    print(f"Reset {settings.database_url.split('@')[-1]} for the E2E suite.")


if __name__ == "__main__":
    main()
