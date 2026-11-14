"""Quick stability fixes (SL-73): the page render has a pixel cap, and /health/ready sees the database
and the attachment folder. Synthetic data only."""
from __future__ import annotations

import io

from PIL import Image
from reportlab.pdfgen import canvas
from sqlalchemy.exc import OperationalError

from app import main as app_main


def _pdf(width_pt: float, height_pt: float) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width_pt, height_pt))
    c.drawString(10, 10, "tall page")
    c.showPage()
    c.save()
    return buf.getvalue()


def _upload(client, data: bytes) -> str:
    report = client.post("/reports", json={"technician_name": "R. Tester"}).json()
    r = client.post(f"/reports/{report['id']}/attachments", files={"file": ("a.pdf", data, "application/pdf")})
    assert r.status_code == 201
    return r.json()["id"]


def test_an_extremely_tall_page_is_drawn_smaller_not_at_full_size(client):
    # 200 x 14400 pt at width 2400 would be 2400 x 172800 px (415 megapixels).
    attachment_id = _upload(client, _pdf(200, 14400))
    r = client.get(f"/attachments/{attachment_id}/pages/1?width=2400")
    assert r.status_code == 200
    image = Image.open(io.BytesIO(r.content))
    assert image.width * image.height <= 25_000_000


def test_a_normal_page_keeps_the_requested_width(client):
    attachment_id = _upload(client, _pdf(595, 842))
    image = Image.open(io.BytesIO(client.get(f"/attachments/{attachment_id}/pages/1?width=900").content))
    assert image.width == 900


def test_ready_is_ok_with_a_database_and_a_writable_folder(client):
    r = client.get("/health/ready")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready_is_503_when_the_database_does_not_answer(client, monkeypatch):
    class Broken:
        def __enter__(self):
            raise OperationalError("SELECT 1", {}, Exception("down"))

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(app_main, "SessionLocal", lambda: Broken())
    r = client.get("/health/ready")
    assert r.status_code == 503
    assert r.json() == {"status": "not ready", "problems": ["database"]}


def test_ready_is_503_when_the_folder_cannot_be_written(client, monkeypatch, tmp_path):
    blocked = tmp_path / "file-not-folder"
    blocked.write_text("x")  # a file where the folder should be
    monkeypatch.setattr(app_main.get_settings(), "attachment_storage_dir", str(blocked))
    r = client.get("/health/ready")
    assert r.status_code == 503
    assert r.json()["problems"] == ["storage"]


def test_ready_stays_open_behind_the_shared_password(monkeypatch):
    from app.shared_password import OPEN_PATHS

    assert "/health/ready" in OPEN_PATHS
