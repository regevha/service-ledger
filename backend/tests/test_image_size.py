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


def _photo(width: int, height: int, fmt: str = "JPEG", mode: str = "RGB", **save) -> bytes:
    """A noisy picture, like a photo: it does not compress to nothing, so a shrunk copy is smaller."""
    im = Image.effect_noise((width, height), 80).convert(mode)
    buf = io.BytesIO()
    im.save(buf, format=fmt, **save)
    return buf.getvalue()


def test_a_large_jpeg_is_shrunk_keeping_its_proportions():
    original = _photo(4000, 3000)
    data, media_type = reading_copy(original, "image/jpeg")
    assert media_type == "image/jpeg" and len(data) < len(original)
    assert image_dimensions(data) == (2000, 1500)


def test_a_large_portrait_png_and_a_gif_become_jpeg_copies():
    data, media_type = reading_copy(_photo(1500, 3000, "PNG"), "image/png")
    assert (media_type, image_dimensions(data)) == ("image/jpeg", (1000, 2000))
    data, media_type = reading_copy(_photo(2400, 2400, "GIF", "P"), "image/gif")
    assert (media_type, image_dimensions(data)) == ("image/jpeg", (2000, 2000))


def test_a_transparent_png_is_flattened_on_white():
    im = Image.new("RGBA", (2400, 2400), (0, 0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    original = buf.getvalue()
    # a fully transparent picture compresses to almost nothing, so the copy would be larger: the original is kept
    assert reading_copy(original, "image/png") == (original, "image/png")
    noisy = Image.effect_noise((2400, 2400), 80).convert("RGBA")
    noisy.putalpha(Image.new("L", noisy.size, 128))
    buf = io.BytesIO()
    noisy.save(buf, format="PNG")
    data, media_type = reading_copy(buf.getvalue(), "image/png")
    assert media_type == "image/jpeg" and image_dimensions(data) == (2000, 2000)


def test_the_copy_is_never_larger_than_the_original():
    low_quality = _photo(4000, 3000, quality=3)  # already tiny: re-encoding at 90 would grow it
    data, media_type = reading_copy(low_quality, "image/jpeg")
    assert len(data) <= len(low_quality)
    webp = _photo(3000, 2250, "WEBP", quality=40)
    data, media_type = reading_copy(webp, "image/webp")
    assert len(data) <= len(webp)


def test_exif_orientation_is_applied_to_the_copy():
    im = Image.effect_noise((4000, 3000), 80).convert("RGB")
    exif = Image.Exif()
    exif[0x0112] = 6  # rotated 90 degrees: shown portrait
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=exif)
    data, media_type = reading_copy(buf.getvalue(), "image/jpeg")
    assert image_dimensions(data) == (1500, 2000)


def test_an_image_within_the_reading_size_is_sent_unchanged():
    original = _img(2000, 1500, "JPEG")
    assert reading_copy(original, "image/jpeg") == (original, "image/jpeg")


def _forged_png_header(width: int, height: int) -> bytes:
    """A few hundred bytes that claim a huge picture: a decompression bomb with no pixels."""
    import struct
    import zlib

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")


@pytest.mark.parametrize("size", [(12000, 9000), (20000, 20000), (100000, 100000)])
def test_a_forged_huge_header_is_refused_at_upload_not_just_the_moderate_ones(client, size):
    r = _upload(client, _forged_png_header(*size))
    assert r.status_code == 422
    assert "too large" in r.json()["detail"] or "too many pixels" in r.json()["detail"]


def test_a_forged_huge_header_is_not_decoded_for_the_model():
    data = _forged_png_header(20000, 20000)
    assert reading_copy(data, "image/png") == (data, "image/png")


def test_the_model_gets_the_shrunk_copy_and_the_stored_original_is_untouched(client, tmp_path):
    original = _photo(3000, 2400, quality=40)  # under the upload byte cap, over the reading size
    r = _upload(client, original, "photo.jpg", "image/jpeg")
    assert r.status_code == 201
    attachment_id = r.json()["id"]
    assert client.get(f"/attachments/{attachment_id}/file").content == original  # download: the original

    path = tmp_path / "photo.jpg"
    path.write_bytes(original)
    block = claude_content_block(path)
    assert block["type"] == "image" and block["source"]["media_type"] == "image/jpeg"
    assert image_dimensions(base64.b64decode(block["source"]["data"])) == (2000, 1600)
    assert path.read_bytes() == original


def test_the_limits_can_be_changed_in_settings(monkeypatch):
    monkeypatch.setattr(get_settings(), "max_image_long_side", 1000)
    assert image_dimensions(reading_copy(_photo(3000, 2000, "PNG"), "image/png")[0]) == (1000, 667)


def test_an_image_limit_below_one_pixel_is_refused_at_startup():
    from pydantic import ValidationError

    from app.config import Settings

    with pytest.raises(ValidationError):
        Settings(min_image_long_side=0)
