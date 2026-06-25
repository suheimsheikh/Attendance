"""Photo / thumbnail helpers.

- `MAX_PHOTO_BYTES`: rejection threshold for any base64 photo POSTed by the
  client. Frontend already shrinks selfies to ~30 KB; the limit catches abuse.
- `THUMB_MAX_PX`, `THUMB_QUALITY`: target shape for the list-view thumbnail
  (Presence Board, Muster Roll, Sessions, Members list).
- `Image.MAX_IMAGE_PIXELS`: decompression-bomb guard. Without this a malicious
  50 KB PNG can decode to multi-GB in RAM.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Optional

from fastapi import HTTPException
from PIL import Image

logger = logging.getLogger(__name__)

# Bomb guard — must be set before any Image.open call (we set it on import).
Image.MAX_IMAGE_PIXELS = 8_000_000

MAX_PHOTO_BYTES = 250_000  # ~30 KB selfie x 8 — generous, still rejects abuse
THUMB_MAX_PX = 96
THUMB_QUALITY = 70


def check_photo_size(photo: Optional[str]) -> None:
    if photo and len(photo) > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Photo too large ({len(photo)} bytes; max {MAX_PHOTO_BYTES})",
        )


def make_thumbnail(photo: Optional[str]) -> Optional[str]:
    """Take a `data:image/...;base64,...` string and return a tiny JPEG data URL.
    Returns None if `photo` is falsy or cannot be decoded — the caller should
    keep the original photo as the only source in that case."""
    if not photo or not isinstance(photo, str):
        return None
    try:
        # Strip the data-URL prefix if present
        b64 = photo.split(",", 1)[1] if photo.startswith("data:") else photo
        raw = base64.b64decode(b64)
        with Image.open(io.BytesIO(raw)) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX_PX, THUMB_MAX_PX))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=THUMB_QUALITY, optimize=True)
            enc = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{enc}"
    except Image.DecompressionBombError as e:
        logger.warning("Rejected oversized image (decompression bomb guard): %s", e)
        return None
    except Exception as e:
        logger.warning("Failed to build thumbnail: %s", e)
        return None
