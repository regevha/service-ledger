"""Test fixtures.

Runs against a real Postgres database (calibration_ledger_test) rather than
an in-memory/sqlite substitute: the whole point of §5's JSONB design is
Postgres-specific behavior, which SQLite doesn't faithfully stand in for.
Tables are truncated between tests instead of using a rollback-per-test
transaction — simpler to reason about and avoids the SAVEPOINT bookkeeping
that pairing a session with an already-open connection transaction needs.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg2://calibration_ledger:calibration_ledger_dev@localhost:5432/calibration_ledger_test",
)
# Force stub mode regardless of the developer's own backend/.env: these tests
# upload fake, non-PDF byte strings and assert exact hardcoded stub values
# (e.g. "No see events"), so a real Claude call here would both waste a
# credit and immediately fail on invalid PDF content. USE_LIVE_CLAUDE is only
# ever meant to be live for the running dev server, never for the test suite.
os.environ["USE_LIVE_CLAUDE"] = "false"

from app import seed_instruments, seed_templates  # noqa: E402
from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

test_engine = create_engine(os.environ["DATABASE_URL"], future=True)
TestSessionLocal = sessionmaker(bind=test_engine, autoflush=False, autocommit=False, future=True)


@pytest.fixture(scope="session", autouse=True)
def _schema():
    Base.metadata.create_all(bind=test_engine)
    yield
    Base.metadata.drop_all(bind=test_engine)


@pytest.fixture(autouse=True)
def _clean_tables():
    with test_engine.begin() as conn:
        for table in ("extraction_jobs", "attachments", "reports", "report_templates", "instruments"):
            conn.execute(text(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture()
def db_session():
    session = TestSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def seeded(db_session):
    seed_instruments.seed(db_session)
    seed_templates.seed(db_session)
    return db_session


@pytest.fixture()
def client(seeded):
    def _override_get_db():
        db = TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
