"""Phone-number normalization. Pure string ops."""
from __future__ import annotations

import re


def normalize_phone(raw: str) -> str:
    """Keep digits only; drop a leading country code's plus. Used to match mobile numbers."""
    return re.sub(r"[^0-9]", "", raw or "")


def phone_key(raw: str) -> str:
    """Comparable key: last 10 digits, so +91-99911 10001 == 9991110001."""
    d = normalize_phone(raw)
    return d[-10:] if len(d) >= 10 else d
