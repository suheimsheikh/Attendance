"""Unit tests for `services/photo.py` — thumbnailing + size guard."""
import base64
import io

import pytest
from fastapi import HTTPException
from PIL import Image

from services.photo import (
    MAX_PHOTO_BYTES, THUMB_MAX_PX,
    check_photo_size, make_thumbnail,
)


def _make_data_url(width: int, height: int, fmt: str = "PNG") -> str:
    """Build a real base64 data URL containing a solid-blue image of the given size."""
    im = Image.new("RGB", (width, height), color=(70, 130, 180))
    buf = io.BytesIO()
    im.save(buf, format=fmt)
    enc = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/{fmt.lower()};base64,{enc}"


def test_check_photo_size_passes_for_small_photo():
    # 10 bytes under the limit — no exception.
    check_photo_size("x" * (MAX_PHOTO_BYTES - 10))
    check_photo_size(None)
    check_photo_size("")


def test_check_photo_size_rejects_oversized_photo():
    with pytest.raises(HTTPException) as ei:
        check_photo_size("x" * (MAX_PHOTO_BYTES + 1))
    assert ei.value.status_code == 413
    # Friendly message should reference KB and "too big".
    assert "too big" in ei.value.detail.lower()
    assert "kb" in ei.value.detail.lower()


def test_make_thumbnail_returns_none_for_empty():
    assert make_thumbnail(None) is None
    assert make_thumbnail("") is None
    assert make_thumbnail("not a data url") is None


def test_make_thumbnail_returns_jpeg_data_url():
    src = _make_data_url(640, 480)
    thumb = make_thumbnail(src)
    assert thumb is not None
    assert thumb.startswith("data:image/jpeg;base64,")
    # Decode and verify it's actually a JPEG <= THUMB_MAX_PX on the longest side.
    raw = base64.b64decode(thumb.split(",", 1)[1])
    im = Image.open(io.BytesIO(raw))
    assert im.format == "JPEG"
    assert max(im.size) <= THUMB_MAX_PX
    # Source was much bigger — thumbnail must be smaller than the source bytes.
    assert len(raw) < len(base64.b64decode(src.split(",", 1)[1]))


def test_make_thumbnail_accepts_raw_base64_without_prefix():
    # Some legacy data was stored without the "data:image/...;base64," header.
    src = _make_data_url(120, 120, fmt="PNG")
    raw_b64 = src.split(",", 1)[1]
    thumb = make_thumbnail(raw_b64)
    assert thumb is not None
    assert thumb.startswith("data:image/jpeg;base64,")


def test_make_thumbnail_handles_corrupt_input_gracefully():
    # Garbage base64 should not raise — caller falls back to original photo.
    assert make_thumbnail("data:image/png;base64,###not_b64###") is None
