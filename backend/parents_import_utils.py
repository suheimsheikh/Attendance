"""
Tiny string-cleaning helpers used by the `/members/import-parents` route in
`server.py`. Extracted from `server.py` to keep the top-level routing file
tighter — these helpers are only relevant to the parents-import workflow.
"""
from __future__ import annotations

import difflib
from typing import Optional


def norm_name(s: str) -> str:
    """Normalize a sailor / member name for matching across the parents file
    and the existing DB. Lowercases, collapses whitespace.
    ('PREETHI KONGARA' → 'preethi kongara')."""
    if not s:
        return ""
    return " ".join(str(s).strip().lower().split())


def fuzzy_score(a: str, b: str) -> float:
    """Lightweight similarity (0-1) on normalized names. Surfaces
    near-matches when the spreadsheet spelling drifts slightly from the
    DB ('Preethi Kongra' vs 'Preethi Kongara')."""
    return difflib.SequenceMatcher(None, norm_name(a), norm_name(b)).ratio()


def norm_mobile(v) -> Optional[str]:
    """Coerce an Excel mobile cell (int, float, or string) into a clean
    digits-only string. Returns None for blanks and common "no number"
    markers ('LATE', '-', 'N/A', etc.) so the DB stores a clean null."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        n = int(v)
        if n <= 0:
            return None
        return str(n)
    s = str(v).strip()
    if not s:
        return None
    if s.upper() in ("LATE", "N/A", "NA", "-", "--", "NIL", "NONE"):
        return None
    digits = "".join(c for c in s if c.isdigit())
    return digits or None


def clean_name(v) -> Optional[str]:
    """Strip "no name" markers and a leading "LATE " prefix used in the
    YCH parents sheet for deceased parents."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.upper() in ("-", "--", "N/A", "NA", "NIL", "NONE", "LATE"):
        return None
    if s.upper().startswith("LATE "):
        s = s[5:].strip()
    return s or None
