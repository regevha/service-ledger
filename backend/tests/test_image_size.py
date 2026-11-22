"""Image size checks: too small or too many pixels are refused at upload; a large image is shrunk for the
model only, and the stored original is untouched."""
from __future__ import annotations

import base64
import io

import pytest
from PIL import Image

from app.config import get_settings
from app.services.documents import claude_content_block
from app.services.image_size import (
    ImageSizeError,
    check_image_size,
    image_dimensions,
    reading_copy,
)


def _img(width: int, height: int, fmt: str = "PNG", mode: str = "RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, (width, height), "white").save(buf, format=fmt)
    return buf.getvalue()


def _upload(client, data: bytes, name: str = "scan.png", mime: str = "image/png"):
    report = client.post("/reports", json={}).json()
    return client.post(f"/reports/{report['id']}/attachments", files={"file": (name, data, mime)})


@pytest.mark.parametrize("size", [(600, 300), (300, 600), (800, 600), (1200, 1600)])
def test_a_big_enough_image_is_accepted(client, size):
    assert _upload(client, _img(*size)).status_code == 201


@pytest.mark.parametrize("size", [(599, 300), (600, 299), (299, 600), (64, 64), (16, 16)])
def test_a_too_small_image_is_refused_with_its_size_and_the_minimum(client, size):
    r = _upload(client, _img(*size))
    assert r.status_code == 422
    assert f"{size[0]} x {size[1]}" in r.json()["detail"] and "600 x 300" in r.json()["detail"]


def test_a_refused_image_leaves_nothing_behind(client):
    report = client.post("/reports", json={}).json()
    r = client.post(f"/reports/{report['id']}/attachments", files={"file": ("i.png", _img(32, 32), "image/png")})
    assert r.status_code == 422
    assert not (get_settings().attachment_storage_path / report["id"]).exists()  # nothing was written to disk


def test_too_many_pixels_is_refused(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_image_pixels_total", 500_000)
    r = _upload(client, _img(1000, 1000))
    assert r.status_code == 422 and "too large" in r.json()["detail"]
    assert _upload(client, _img(800, 600)).status_code == 201  # 480,000 pixels is under the ceiling


def test_a_jpeg_and_a_gif_are_checked_too(client):
    assert _upload(client, _img(100, 100, "JPEG"), "p.jpg", "image/jpeg").status_code == 422
    assert _upload(client, _img(100, 100, "GIF", "P"), "p.gif", "image/gif").status_code == 422
    assert _upload(client, _img(800, 600, "JPEG"), "p.jpg", "image/jpeg").status_code == 201


def test_an_unreadable_image_is_not_judged_by_size():
    check_image_size(b"\x89PNG\r\n\x1a\n" + b"0" * 32)  # no ImageSizeError: reading it fails later, as before
    assert image_dimensions(b"\x89PNG\r\n\x1a\n" + b"0" * 32) is None


def test_the_minimum_is_checked_on_each_side():
    with pytest.raises(ImageSizeError):
        check_image_size(_img(2000, 200))  # long enough, but the short side is below the minimum


def test_a_large_jpeg_is_shrunk_keeping_its_proportions():
    data, media_type = reading_copy(_img(4000, 3000, "JPEG"), "image/jpeg")
    assert media_type == "image/jpeg"
    assert image_dimensions(data) == (2000, 1500)


def test_a_large_portrait_png_and_a_gif_become_png():
    data, media_type = reading_copy(_img(1500, 3000), "image/png")
    assert (media_type, image_dimensions(data)) == ("image/png", (1000, 2000))
    data, media_type = reading_copy(_img(2400, 2400, "GIF", "P"), "image/gif")
    assert (media_type, image_dimensions(data)) == ("image/png", (2000, 2000))


def test_an_image_within_the_reading_size_is_sent_unchanged():
    original = _img(2000, 1500, "JPEG")
    assert reading_copy(original, "image/jpeg") == (original, "image/jpeg")


def test_the_model_gets_the_shrunk_copy_and_the_stored_original_is_untouched(client, tmp_path):
    original = _img(4000, 3000, "JPEG")
    r = _upload(client, original, "photo.jpg", "image/jpeg")
    assert r.status_code == 201
    attachment_id = r.json()["id"]
    assert client.get(f"/attachments/{attachment_id}/file").content == original  # download: the original

    path = tmp_path / "photo.jpg"
    path.write_bytes(original)
    block = claude_content_block(path)
    assert block["type"] == "image" and block["source"]["media_type"] == "image/jpeg"
    assert image_dimensions(base64.b64decode(block["source"]["data"])) == (2000, 1500)
    assert path.read_bytes() == original


def test_the_limits_can_be_changed_in_settings(monkeypatch):
    monkeypatch.setattr(get_settings(), "max_image_long_side", 1000)
    assert image_dimensions(reading_copy(_img(3000, 2000), "image/png")[0]) == (1000, 667)


def test_an_image_limit_below_one_pixel_is_refused_at_startup():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(min_image_long_side=0)
