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
import hashlib
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
        # Human-friendly KB sizes — coaches don't need to count bytes.
        # Backend log can be re-derived from the X-Request-ID if needed.
        kb_max = MAX_PHOTO_BYTES // 1024
        kb_got = len(photo) // 1024
        raise HTTPException(
            status_code=413,
            detail=(
                f"That photo is too big ({kb_got} KB). "
                f"Try retaking it — the limit is {kb_max} KB. "
                "Most modern phone cameras will work if you crop or use the front camera."
            ),
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


def member_photo_url(u: dict) -> Optional[str]:
    """Build the tiny relative URL used by list endpoints as a
    stand-in for the base64 photo. Returns None when the member has
    no photo at all.

    `v` is a short hash of the underlying image bytes so browsers can
    cache the response for a year yet still refresh instantly when the
    admin uploads a new photo (hash changes → cache miss on new URL).

    Perf pass 24 Feb 2026 — hoisted from server.py so muster and meals
    route modules can share the same URL scheme. Cuts Muster/Meals
    response bodies from ~430 KB → ~30 KB.
    """
    thumb = u.get("photo_thumb") or u.get("photo")
    if not thumb:
        return None
    # SHA-256 truncated to 10 hex chars — not security-sensitive, just
    # a fingerprint so `?v=` changes when a new photo is uploaded.
    version = hashlib.sha256(thumb.encode("utf-8", errors="ignore")).hexdigest()[:10]
    return f"/api/members/{u['id']}/photo?v={version}"
