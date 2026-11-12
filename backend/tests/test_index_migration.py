"""Migration 0013 adds the indexes and downgrade removes them again (phase 3.1).

Runs alembic against a throwaway database so it never touches the test database's schema.
"""
import os
import subprocess
import sys
import uuid
from pathlib import Path

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND = Path(__file__).resolve().parents[1]
INDEXES = {
    "ix_reports_instrument_id",
    "ix_reports_template_id",
    "ix_reports_status",
    "ix_reports_report_date",
    "ix_attachments_report_id",
    "ix_extraction_jobs_attachment_id",
    "ix_extraction_jobs_pending",
}


def _alembic(url: str, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": url}
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, check=True, capture_output=True)


def _present(url: str) -> set[str]:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("SELECT indexname FROM pg_indexes WHERE indexname = ANY(:n)"), {"n": list(INDEXES)})
            return {r[0] for r in rows}
    finally:
        engine.dispose()


def test_the_index_migration_upgrades_and_downgrades():
    base = make_url(os.environ["DATABASE_URL"])
    name = f"sl_idx_{uuid.uuid4().hex[:8]}"
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name).render_as_string(hide_password=False)
    try:
        _alembic(url, "upgrade", "head")
        assert _present(url) == INDEXES
        _alembic(url, "downgrade", "0012_attachment_filename")
        assert _present(url) == set()
        _alembic(url, "upgrade", "head")
        assert _present(url) == INDEXES
    finally:
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
