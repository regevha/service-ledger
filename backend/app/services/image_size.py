"""Size checks for uploaded images, all before any model call and free.

* too small (an icon or thumbnail uploaded by mistake): refused at upload;
* too many pixels (a decoding risk): refused at upload;
* larger than the reading size: shrunk, but only the copy sent to the model. The stored original is untouched.

Header-only checks: Pillow reads the dimensions without decoding the pixels. A file whose header Pillow cannot
read is not judged here (it is not our job to reject it at upload; reading it fails later as before).
"""
from __future__ import annotations

import io
import logging

from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import get_settings

logger = logging.getLogger("app.services.image_size")


class ImageSizeError(Exception):
    """The image is too small or too large to accept. The message is for the uploader."""


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) from the header, or None when the bytes are not an image Pillow can open."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            return im.size
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return None


def check_image_size(data: bytes) -> None:
    """Raise ImageSizeError when the image is below the minimum size or above the pixel ceiling."""
    s = get_settings()
    size = image_dimensions(data)
    if size is None:
        return
    width, height = size
    long_side, short_side = max(width, height), min(width, height)
    if width * height > s.max_image_pixels_total:
        raise ImageSizeError(
            f"This image is {width} x {height} pixels, which is too large to open safely "
            f"(over {s.max_image_pixels_total // 1_000_000} million pixels). Reduce its resolution and upload it again."
        )
    if long_side < s.min_image_long_side or short_side < s.min_image_short_side:
        raise ImageSizeError(
            f"This image is only {width} x {height} pixels, too small to be a readable service report "
            f"(at least {s.min_image_long_side} x {s.min_image_short_side} pixels). Upload the full page or a larger photo."
        )


def reading_copy(data: bytes, media_type: str) -> tuple[bytes, str]:
    """The bytes and media type to send to the model: the image itself, or when its long side exceeds the
    reading size a shrunk copy with the same proportions (JPEG stays JPEG, everything else becomes PNG)."""
    limit = get_settings().max_image_long_side
    size = image_dimensions(data)
    if size is None or max(size) <= limit:
        return data, media_type
    try:
        with Image.open(io.BytesIO(data)) as opened:
            im: Image.Image = ImageOps.exif_transpose(opened) or opened
            scale = limit / max(im.size)
            new_size = (max(1, round(im.width * scale)), max(1, round(im.height * scale)))
            small = im.convert("RGB" if media_type == "image/jpeg" else "RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
            small = small.resize(new_size, Image.Resampling.LANCZOS)
            out = io.BytesIO()
            if media_type == "image/jpeg":
                small.save(out, format="JPEG", quality=90)
                return out.getvalue(), "image/jpeg"
            small.save(out, format="PNG", optimize=True)
            return out.getvalue(), "image/png"
    except (OSError, ValueError, Image.DecompressionBombError) as e:
        logger.warning("Could not shrink an oversized image, sending it as stored: %s", type(e).__name__)
        return data, media_type
