"""Phase 3.3: attachment paths are stored relative to the storage root, so a database restored next to
a different mount still finds its files."""
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.config import get_settings
from app.services.storage_paths import to_absolute, to_stored

BACKEND = Path(__file__).resolve().parents[1]


def test_to_stored_is_relative_inside_the_root_and_unchanged_outside(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    assert to_stored(str(root / "r1" / "a.pdf"), root) == "r1/a.pdf"
    assert to_stored("/somewhere/else/a.pdf", root) == "/somewhere/else/a.pdf"


def test_to_absolute_joins_the_root_and_refuses_to_climb_out_of_it(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    assert to_absolute("r1/a.pdf", root) == str(root / "r1" / "a.pdf")
    assert to_absolute("/somewhere/else/a.pdf", root) == "/somewhere/else/a.pdf"
    with pytest.raises(ValueError):
        to_absolute("../outside.pdf", root)


def test_the_database_holds_the_relative_path_and_the_model_gives_the_full_one(client, db_session):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    sent = client.post(f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")})
    assert sent.status_code == 201
    stored = db_session.execute(text("SELECT file_path FROM attachments WHERE id = :i"), {"i": sent.json()["id"]}).scalar_one()
    assert not Path(stored).is_absolute() and stored.startswith(report["id"])
    root = get_settings().attachment_storage_path
    assert Path(sent.json()["file_path"]) == root / stored and Path(sent.json()["file_path"]).exists()


def test_files_are_found_after_the_storage_moves_to_another_mount(client, monkeypatch, tmp_path):
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    sent = client.post(f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")})
    att = sent.json()["id"]
    old = Path(sent.json()["file_path"])
    new_root = tmp_path / "new-mount"
    (new_root / report["id"]).mkdir(parents=True)
    (new_root / report["id"] / old.name).write_bytes(old.read_bytes())
    old.unlink()
    monkeypatch.setattr(get_settings(), "attachment_storage_dir", str(new_root))
    assert client.get(f"/attachments/{att}/file").status_code == 200


def test_the_path_migration_converts_rows_under_the_root_and_downgrade_restores_them(tmp_path):
    base = make_url(os.environ["DATABASE_URL"])
    name = f"sl_paths_{uuid.uuid4().hex[:8]}"
    admin = create_engine(base.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = base.set(database=name).render_as_string(hide_password=False)
    root = tmp_path / "root"
    root.mkdir()
    env = {**os.environ, "DATABASE_URL": url, "ATTACHMENT_STORAGE_DIR": str(root)}

    def alembic(*args):
        subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, check=True, capture_output=True)

    engine = create_engine(url)
    try:
        alembic("upgrade", "0015_indexes")
        rid, inside, outside = str(uuid.uuid4()), str(root / "r1" / "a.pdf"), "/elsewhere/b.pdf"
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO reports (id, status, technician_name, extracted_fields) VALUES (:i, 'draft', 'T', '{}')"), {"i": rid})
            for path in (inside, outside):
                conn.execute(text("INSERT INTO attachments (id, report_id, file_path, file_type, page_count) VALUES (:i, :r, :p, 'application/pdf', 1)"),
                             {"i": str(uuid.uuid4()), "r": rid, "p": path})

        def paths():
            with engine.connect() as conn:
                return sorted(r[0] for r in conn.execute(text("SELECT file_path FROM attachments")))

        alembic("upgrade", "head")
        assert paths() == sorted(["r1/a.pdf", outside])
        alembic("downgrade", "0015_indexes")
        assert paths() == sorted([inside, outside])
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
