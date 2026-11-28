"""Email-intake upgrade/downgrade/re-upgrade and drift on an isolated database."""
import os
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlencode

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import make_url

BACKEND = Path(__file__).resolve().parents[1]
TABLES = {"intake_allow_entries", "intake_messages", "intake_files", "report_sources", "intake_notification_opt_outs"}
ENUMS = {"intake_allow_kind", "intake_message_outcome", "intake_reply_status",
         "intake_file_outcome", "intake_read_state", "report_source_channel"}


def alembic(url, *args):
    result = subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND,
                            env={**os.environ, "DATABASE_URL": url}, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_email_intake_migration_round_trip():
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "alembic"))
    assert ScriptDirectory.from_config(config).get_heads() == ["0019_receipt_filenames"]
    base = make_url(os.environ["DATABASE_URL"])
    name = f"sl_email_{uuid.uuid4().hex[:8]}"
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    engine = None
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    # Keep Unix socket path slashes literal: Alembic's ConfigParser treats percent
    # escapes from URL.render_as_string as interpolation directives.
    url = base.set(database=name, query={}).render_as_string(hide_password=False)
    if base.query:
        url += "?" + urlencode(base.query, doseq=True, safe="/")
    try:
        alembic(url, "upgrade", "0016_relative_attachment_paths")
        engine = create_engine(url)
        # A pre-existing web report must survive both directions unchanged.
        report_id = uuid.uuid4()
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO reports (id, status, extracted_fields) VALUES (:id, 'draft', '{}')"),
                         {"id": report_id})
        for _ in range(2):
            alembic(url, "upgrade", "head")
            assert TABLES <= set(inspect(engine).get_table_names())
            assert ENUMS <= {item["name"] for item in inspect(engine).get_enums()}
            alembic(url, "check")
            with engine.connect() as conn:
                assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar_one() == "0019_receipt_filenames"
                assert conn.execute(text("SELECT id FROM reports WHERE id = :id"), {"id": report_id}).scalar_one() == report_id
            alembic(url, "downgrade", "0016_relative_attachment_paths")
            assert TABLES.isdisjoint(inspect(engine).get_table_names())
            names = {item["name"] for item in inspect(engine).get_enums()}
            assert ENUMS.isdisjoint(names)
            assert "extraction_job_kind" in names
        alembic(url, "upgrade", "head")
        alembic(url, "check")
    finally:
        if engine is not None:
            engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
