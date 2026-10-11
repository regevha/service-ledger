"""Test fixtures.

Runs against a real Postgres database (service_ledger_test) rather than
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
    "postgresql+psycopg2://service_ledger:service_ledger_dev@localhost:5432/service_ledger_test",
)
# Force stub mode regardless of the developer's own backend/.env: these tests
# upload fake, non-PDF byte strings and assert exact hardcoded stub values
# (e.g. "No see events"), so a real Claude call here would both waste a
# credit and immediately fail on invalid PDF content. USE_LIVE_CLAUDE is only
# ever meant to be live for the running dev server, never for the test suite.
os.environ["USE_LIVE_CLAUDE"] = "false"

from app import auth, seed_instruments, seed_templates  # noqa: E402
from app.create_user import upsert_user  # noqa: E402
from app.models import UserRole  # noqa: E402
from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

# Cheap password hashing for tests (the cost is stored in each hash, so real
# hashes still verify with their own cost); production keeps the full cost.
auth._SCRYPT_N = 2**4
PASSWORD = "correct horse battery"

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
        for table in ("user_sessions", "users", "extraction_jobs", "attachments", "reports", "report_templates", "instruments"):
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
def _api(seeded):
    """The app wired to the test database."""

    def _override_get_db():
        db = TestSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_get_db
    yield
    app.dependency_overrides.clear()


def _signed_in(role: UserRole, username: str | None = None) -> TestClient:
    username = username or f"{role.value}-user"
    with TestSessionLocal() as db:
        upsert_user(db, username, PASSWORD, role)
    test_client = TestClient(app)
    test_client.__enter__()
    response = test_client.post("/auth/login", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return test_client


@pytest.fixture()
def client(_api):
    """Signed in as an admin, so tests exercise the API without role limits;
    tests of the limits themselves use `client_as` / `anon_client`."""
    test_client = _signed_in(UserRole.admin)
    yield test_client
    test_client.__exit__(None, None, None)


@pytest.fixture()
def client_as(_api):
    """`client_as("viewer")` -> a client signed in with that role."""
    opened: list[TestClient] = []

    def _make(role: str, username: str | None = None) -> TestClient:
        test_client = _signed_in(UserRole(role), username)
        opened.append(test_client)
        return test_client

    yield _make
    for test_client in opened:
        test_client.__exit__(None, None, None)


@pytest.fixture()
def anon_client(_api):
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def run_worker():
    """classify/extract (§9) now only enqueue a `pending` ExtractionJob and
    return 202 (see app/worker.py) — the real work happens in
    `app.worker.process_one_job`, which in production runs in a loop inside a
    separate process (§3). Tests don't want a real background thread racing
    assertions against a sleep-based poll, so this fixture drives the same
    function synchronously and deterministically: call it right after hitting
    an endpoint that enqueues a job, and every currently-pending job is fully
    processed (classify, or extract, however many are queued) before it
    returns.
    """
    from app.worker import process_one_job

    def _run(max_jobs: int = 10) -> int:
        processed = 0
        with TestSessionLocal() as db:
            while processed < max_jobs and process_one_job(db):
                processed += 1
        return processed

    return _run
