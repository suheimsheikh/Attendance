"""
Behaviour-lock unit tests for the two pure helpers extracted from
`routes.dashboard.dashboard()` during the Feb 2026 complexity pass:

  * `_hydrate_top_users`  — turns a ranked (uid, value) list into
                            the dashboard's "Top 5" widget row shape,
                            used by both top_late and top_ot rails.
  * `_pack_events`        — normalises camp/regatta rows into a
                            uniform event dict for the week card.

Pure sync tests, no DB, no HTTP. Guarantees the frontend contract
(field names + ordering + limit + skip-missing-user) doesn't drift.
"""
from __future__ import annotations

from routes.dashboard import _hydrate_top_users, _pack_events


def _users():
    """Fixture: a small users_by_id map."""
    return {
        "u1": {"id": "u1", "full_name": "Alice", "category": "staff", "photo_thumb": "aP"},
        "u2": {"id": "u2", "full_name": "Bob",   "category": "coach", "photo_thumb": "bP"},
        "u3": {"id": "u3", "full_name": "Cara",  "category": "athlete", "photo_thumb": None},
    }


# ── _hydrate_top_users ───────────────────────────────────────────────
def test_hydrate_empty_ranked_returns_empty():
    assert _hydrate_top_users([], _users(), value_key="late_days") == []


def test_hydrate_emits_full_widget_shape():
    """Contract: {member_id, name, category, photo, <value_key>}"""
    out = _hydrate_top_users(
        [("u1", 5), ("u2", 3)], _users(), value_key="late_days",
    )
    assert out == [
        {"member_id": "u1", "name": "Alice", "category": "staff",
         "photo": "aP", "late_days": 5},
        {"member_id": "u2", "name": "Bob", "category": "coach",
         "photo": "bP", "late_days": 3},
    ]


def test_hydrate_preserves_input_order():
    """Helper does NOT re-sort — input order is the ranking (caller
    already sorted). Regression guard: swapping input order swaps
    output order 1:1."""
    users = _users()
    a = _hydrate_top_users([("u2", 1), ("u1", 9)], users, value_key="v")
    b = _hydrate_top_users([("u1", 9), ("u2", 1)], users, value_key="v")
    assert [r["member_id"] for r in a] == ["u2", "u1"]
    assert [r["member_id"] for r in b] == ["u1", "u2"]


def test_hydrate_respects_default_limit_5():
    ranked = [(f"u{i}", i) for i in range(1, 11)]   # 10 rows
    users = {f"u{i}": {"id": f"u{i}", "full_name": f"n{i}",
                       "category": "staff", "photo_thumb": None}
             for i in range(1, 11)}
    out = _hydrate_top_users(ranked, users, value_key="v")
    assert len(out) == 5
    assert [r["member_id"] for r in out] == ["u1", "u2", "u3", "u4", "u5"]


def test_hydrate_respects_custom_limit():
    ranked = [(f"u{i}", i) for i in range(1, 11)]
    users = {f"u{i}": {"id": f"u{i}", "full_name": "x",
                       "category": "staff", "photo_thumb": None}
             for i in range(1, 11)}
    out = _hydrate_top_users(ranked, users, value_key="v", limit=3)
    assert len(out) == 3


def test_hydrate_skips_missing_user_without_padding():
    """A user_id no longer in users_by_id (soft-deleted mid-week) is
    silently skipped — the widget shows one fewer row, NOT a blank."""
    out = _hydrate_top_users(
        [("u1", 5), ("gone", 4), ("u2", 3)], _users(), value_key="v",
    )
    assert [r["member_id"] for r in out] == ["u1", "u2"]


def test_hydrate_value_key_is_arbitrary():
    """Same helper drives BOTH the late-comers rail (`late_days`) AND
    the OT rail (`ot_minutes`) — verify the key is applied verbatim."""
    users = _users()
    late = _hydrate_top_users([("u1", 2)], users, value_key="late_days")
    ot   = _hydrate_top_users([("u1", 120)], users, value_key="ot_minutes")
    assert "late_days" in late[0] and "ot_minutes" not in late[0]
    assert "ot_minutes" in ot[0]   and "late_days" not in ot[0]


# ── _pack_events ─────────────────────────────────────────────────────
def test_pack_events_empty():
    assert _pack_events([], "camp") == []


def test_pack_events_shape_for_camp_and_regatta():
    rows = [
        {"id": "c1", "name": "Sat Camp", "start_date": "2026-08-01",
         "end_date": "2026-08-02", "extra": "ignored"},
    ]
    got = _pack_events(rows, "camp")
    assert got == [{
        "kind": "camp", "id": "c1", "name": "Sat Camp",
        "start_date": "2026-08-01", "end_date": "2026-08-02",
    }]
    # And the same rows re-packed as regatta only flip the kind.
    got_r = _pack_events(rows, "regatta")
    assert got_r[0]["kind"] == "regatta"
    assert got_r[0]["name"] == "Sat Camp"


def test_pack_events_missing_fields_yield_none_not_keyerror():
    """A row without name/start/end shouldn't crash the dashboard —
    the widget copes with Nones, but a KeyError would 500 the entire
    endpoint. Regression guard for defensive handling."""
    got = _pack_events([{}], "camp")
    assert got == [{
        "kind": "camp", "id": None, "name": None,
        "start_date": None, "end_date": None,
    }]
