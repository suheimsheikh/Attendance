"""
Behaviour-lock unit tests for `data_quality._find_duplicates` — the
shared helper that replaced 4 near-identical duplicate-detection
loops (email / mobile / full-name / escort-phone) in the Data
Quality sweep.

Pure, sync, DB-free. Pins the exact shape of every emitted finding
so a future edit that alters the frontend contract trips CI.
"""
from __future__ import annotations

from routes.data_quality import _find_duplicates


def _u(id_, **kw):
    """Minimal user row for tests — id + arbitrary fields."""
    return {"id": id_, **kw}


def test_empty_input_returns_empty_list():
    assert _find_duplicates(
        [], key_fn=lambda u: u.get("email", ""),
        code="member.duplicate_email", severity="high",
        build_message=lambda k, g: f"{k}={len(g)}",
    ) == []


def test_singletons_are_ignored():
    """A bucket with just 1 row is not a duplicate — nothing emitted."""
    rows = [_u("a", email="one@x"), _u("b", email="two@x")]
    assert _find_duplicates(
        rows, key_fn=lambda u: (u.get("email") or "").lower(),
        code="member.duplicate_email", severity="high",
        build_message=lambda k, g: f"{k}",
    ) == []


def test_empty_key_rows_are_skipped_even_if_common():
    """Two rows with `email=""` do NOT count as duplicates — an empty
    key means "no email to compare"."""
    rows = [_u("a", email=""), _u("b", email=""), _u("c", email="")]
    assert _find_duplicates(
        rows, key_fn=lambda u: (u.get("email") or "").strip().lower(),
        code="member.duplicate_email", severity="high",
        build_message=lambda k, g: f"{k}",
    ) == []


def test_emits_one_finding_per_duplicate_bucket_with_expected_shape():
    rows = [
        _u("1", email="Same@X", full_name="Alice"),
        _u("2", email="same@x", full_name="Bob"),
        _u("3", email="other@x", full_name="Charlie"),
    ]
    out = _find_duplicates(
        rows,
        key_fn=lambda u: (u.get("email") or "").strip().lower(),
        code="member.duplicate_email",
        severity="high",
        build_message=lambda k, g: f"Email '{k}' used by {len(g)} members",
    )
    assert len(out) == 1
    f = out[0]
    # Contract shape that the frontend consumes.
    assert f["category"] == "Duplicates"
    assert f["code"] == "member.duplicate_email"
    assert f["severity"] == "high"
    assert f["message"] == "Email 'same@x' used by 2 members"
    assert f["entity_type"] == "member"
    assert sorted(f["entity_ids"]) == ["1", "2"]
    assert sorted(f["entity_names"]) == ["Alice", "Bob"]


def test_multiple_buckets_emit_multiple_findings():
    """Two independent duplicate groups → two findings."""
    rows = [
        _u("1", full_name="Alice"), _u("2", full_name="Alice"),
        _u("3", full_name="Bob"),   _u("4", full_name="Bob"),
        _u("5", full_name="Solo"),
    ]
    out = _find_duplicates(
        rows,
        key_fn=lambda u: (u.get("full_name") or "").upper(),
        code="member.duplicate_name",
        severity="medium",
        build_message=lambda k, g: f"{k} x{len(g)}",
    )
    assert len(out) == 2
    keys = sorted(f["message"] for f in out)
    assert keys == ["ALICE x2", "BOB x2"]


def test_name_fn_takes_precedence_over_name_field():
    """The escort-phone caller uses name_fn to insert '(unnamed)' for
    blank rows — verify that path replaces name_field lookup."""
    rows = [_u("e1", mobile="9999999999", name=""),
            _u("e2", mobile="9999999999", name=None)]
    out = _find_duplicates(
        rows,
        key_fn=lambda e: e.get("mobile") or "",
        code="escort.duplicate_phone",
        severity="medium",
        build_message=lambda k, g: f"phone {k}",
        entity_type="escort",
        name_fn=lambda e: e.get("name") or "(unnamed)",
        category="Escorts",
    )
    assert len(out) == 1
    assert out[0]["entity_names"] == ["(unnamed)", "(unnamed)"]
    assert out[0]["category"] == "Escorts"
    assert out[0]["entity_type"] == "escort"


def test_default_name_field_reads_full_name():
    """No name_fn / name_field passed → defaults to `full_name`."""
    rows = [_u("1", mobile="X", full_name="Alice"),
            _u("2", mobile="X", full_name="Alice-2")]
    out = _find_duplicates(
        rows, key_fn=lambda u: u.get("mobile") or "",
        code="member.duplicate_mobile", severity="high",
        build_message=lambda k, g: f"{k}",
    )
    assert out[0]["entity_names"] == ["Alice", "Alice-2"]


def test_build_message_receives_key_and_group_slice():
    """Regression guard: build_message must see the exact key that
    bucketed the group, not the raw pre-normalised value."""
    rows = [_u("1", email="A@X"), _u("2", email="a@x"), _u("3", email="a@x")]
    seen_keys = []
    _find_duplicates(
        rows,
        key_fn=lambda u: (u.get("email") or "").lower(),
        code="c", severity="s",
        build_message=lambda k, g: (seen_keys.append(k), f"len={len(g)}")[1],
    )
    assert seen_keys == ["a@x"]
