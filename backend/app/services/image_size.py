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
import warnings

from PIL import Image, UnidentifiedImageError

from app.config import get_settings

logger = logging.getLogger("app.services.image_size")


class ImageSizeError(Exception):
    """The image is too small or too large to accept. The message is for the uploader."""


def image_dimensions(data: bytes) -> tuple[int, int] | None:
    """(width, height) from the header, or None when the bytes are not an image Pillow can open.
    Raises Image.DecompressionBombError for an absurd size (Pillow refuses above about twice its own limit)."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)  # our own ceiling decides
            with Image.open(io.BytesIO(data)) as im:
                return im.size
    except (UnidentifiedImageError, OSError, ValueError):
        return None


def check_image_size(data: bytes) -> None:
    """Raise ImageSizeError when the image is below the minimum size or above the pixel ceiling."""
    s = get_settings()
    try:
        size = image_dimensions(data)
    except Image.DecompressionBombError:
        raise ImageSizeError(
            "This image has far too many pixels to open safely. Reduce its resolution and upload it again."
        ) from None
    if size is None:
        return
    width, height = size
    long_side, short_side = max(width, height), min(width, height)
    if width * height > s.max_image_pixels_total:
        raise ImageSizeError(
            f"This image is {width} x {height} pixels, which is too large to open safely "
            f"(over {s.max_image_pixels_total:,} pixels). Reduce its resolution and upload it again."
        )
    if long_side < s.min_image_long_side or short_side < s.min_image_short_side:
        raise ImageSizeError(
            f"This image is only {width} x {height} pixels, too small to be a readable service report "
            f"(at least {s.min_image_long_side} x {s.min_image_short_side} pixels). Upload the full page or a larger photo."
        )


_ORIENTATION = {
    2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180, 4: Image.Transpose.FLIP_TOP_BOTTOM,
    5: Image.Transpose.TRANSPOSE, 6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE, 8: Image.Transpose.ROTATE_90,
}


def reading_copy(data: bytes, media_type: str) -> tuple[bytes, str]:
    """The bytes and media type to send to the model: the image itself, or when its long side exceeds the
    reading size a shrunk JPEG copy with the same proportions. The copy is never larger than the original:
    if it would be, the original is sent. Shrinks first (JPEG decodes at reduced size) and fixes the EXIF
    orientation after, so the large pixel buffer is never copied."""
    limit = get_settings().max_image_long_side
    try:
        size = image_dimensions(data)
    except Image.DecompressionBombError:
        return data, media_type
    if size is None or max(size) <= limit:
        return data, media_type
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as im:
                orientation = im.getexif().get(0x0112, 1)
                im.draft("RGB", (limit, limit))  # JPEG: decode at a reduced size (no effect on other formats)
                im.thumbnail((limit, limit), Image.Resampling.LANCZOS, reducing_gap=2.0)
                small: Image.Image = im
                if small.mode in ("RGBA", "LA") or (small.mode == "P" and "transparency" in small.info):
                    rgba = small.convert("RGBA")
                    small = Image.new("RGB", rgba.size, "white")
                    small.paste(rgba, mask=rgba.getchannel("A"))
                elif small.mode != "RGB":
                    small = small.convert("RGB")
                if orientation in _ORIENTATION:
                    small = small.transpose(_ORIENTATION[orientation])
                out = io.BytesIO()
                small.save(out, format="JPEG", quality=90)
    except (OSError, ValueError, Image.DecompressionBombError) as e:
        logger.warning("Could not shrink an oversized image, sending it as stored: %s", type(e).__name__)
        return data, media_type
    copy = out.getvalue()
    if len(copy) >= len(data):
        return data, media_type
    return copy, "image/jpeg"
