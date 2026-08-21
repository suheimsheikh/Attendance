"""
Behaviour-lock unit tests for the four pure helpers extracted from
`routes.meals.kitchen_analytics` (Feb 2026 pass):

  * `_weighted_rate_lookup`   — wavg purchase rate closure w/ fallback
  * `_kitchen_daily_series`   — daily agg → chart rows
  * `_kitchen_item_rows`      — per-item agg → sortable table rows
  * `_kitchen_cat_pct`        — category agg → pie slice rows

Pure, sync, DB-free. Pins the exact response shape the Kitchen
Analytics UI depends on so a future edit that flips a rounding
digit, drops a field, or breaks the sort order trips CI.
"""
from __future__ import annotations

from routes.meals import (
    _weighted_rate_lookup,
    _kitchen_daily_series,
    _kitchen_item_rows,
    _kitchen_cat_pct,
)


# ── _weighted_rate_lookup ────────────────────────────────────────────
def test_rate_uses_window_wavg_when_item_was_purchased():
    """qty>0 in window → wavg = amount/qty, ignores snapshot."""
    rf = _weighted_rate_lookup(
        purch_qty={"i1": 10.0}, purch_amt={"i1": 1500.0},
        snap_rate={"i1": 999.0},   # should be ignored
    )
    assert rf("i1") == 150.0


def test_rate_falls_back_to_snapshot_when_no_window_purchase():
    """Item issued but not purchased → snap_rate is used (opening
    stock consumption case)."""
    rf = _weighted_rate_lookup(
        purch_qty={}, purch_amt={}, snap_rate={"i2": 42.5},
    )
    assert rf("i2") == 42.5


def test_rate_returns_zero_when_unknown_everywhere():
    """Neither in window nor snapshot → 0.0 (safe default so the
    reconciliation math never crashes)."""
    rf = _weighted_rate_lookup(purch_qty={}, purch_amt={}, snap_rate={})
    assert rf("ghost") == 0.0


def test_rate_wavg_over_multiple_lots():
    """Multiple purchase lots feed into the wavg via the running
    totals — verify the aggregated numbers land at the right rate."""
    rf = _weighted_rate_lookup(
        purch_qty={"i1": 3 + 7},        # 3kg at 100 + 7kg at 200
        purch_amt={"i1": 3*100 + 7*200},
        snap_rate={},
    )
    assert rf("i1") == 170.0            # (300+1400)/10


# ── _kitchen_daily_series ────────────────────────────────────────────
def test_daily_series_empty_returns_empty_list():
    assert _kitchen_daily_series({}) == []


def test_daily_series_sorted_by_date_ascending():
    """Chart-rendering requires ISO-lex sort — regression guard."""
    got = _kitchen_daily_series({
        "2026-08-03": {"amount": 30.0, "qty": 1.0, "lines": 1},
        "2026-08-01": {"amount": 10.0, "qty": 2.0, "lines": 2},
        "2026-08-02": {"amount": 20.0, "qty": 3.0, "lines": 3},
    })
    assert [r["date"] for r in got] == ["2026-08-01", "2026-08-02", "2026-08-03"]


def test_daily_series_rounds_amount_2dp_qty_3dp():
    """Contract: chart consumes fixed precision. amount=₹ (2 dp),
    qty=kg/L (3 dp), lines=count (int)."""
    got = _kitchen_daily_series({
        "2026-08-01": {"amount": 12.3456, "qty": 1.23456, "lines": 4},
    })
    assert got[0] == {"date": "2026-08-01", "amount": 12.35,
                      "qty": 1.235, "lines": 4}


# ── _kitchen_item_rows ───────────────────────────────────────────────
BY_ID = {
    "i1": {"name": "Oil", "unit": "L", "category_key": "grocery"},
    "i2": {"name": "Tomato", "unit": "kg", "category_key": "vegetable"},
}
CAT_LABEL = {"grocery": "Grocery", "vegetable": "Vegetable"}


def test_item_rows_empty_returns_empty_list():
    assert _kitchen_item_rows({}, BY_ID, CAT_LABEL) == []


def test_item_rows_hydrates_name_unit_and_category_label():
    got = _kitchen_item_rows(
        {"i1": {"qty": 3.0, "amount": 7470.0, "lines": 1}},
        BY_ID, CAT_LABEL,
    )
    assert got == [{
        "item_id": "i1", "name": "Oil", "unit": "L",
        "category_key": "grocery", "category_label": "Grocery",
        "qty": 3.0, "amount": 7470.0, "lines": 1,
    }]


def test_item_rows_sorted_by_amount_desc():
    """Table renders top-spend first — regression guard on sort order."""
    got = _kitchen_item_rows({
        "i1": {"qty": 1, "amount": 100, "lines": 1},
        "i2": {"qty": 5, "amount": 500, "lines": 3},
    }, BY_ID, CAT_LABEL)
    assert [r["item_id"] for r in got] == ["i2", "i1"]


def test_item_rows_deleted_item_gets_placeholder_name():
    """`(deleted item)` protects the frontend from a KeyError when a
    line references an item removed post-issue. Empty category_key
    still gets a titled label."""
    got = _kitchen_item_rows(
        {"ghost": {"qty": 1, "amount": 10, "lines": 1}},
        {}, {},
    )
    assert got[0]["name"] == "(deleted item)"
    assert got[0]["category_key"] is None
    assert got[0]["category_label"] == ""


def test_item_rows_category_label_falls_back_to_titled_key():
    """No entry in cat_label → generate from key so table never
    shows a blank column even when a new category key ships before
    its master label."""
    got = _kitchen_item_rows(
        {"i1": {"qty": 1, "amount": 100, "lines": 1}},
        {"i1": {"name": "X", "unit": "kg", "category_key": "cold_storage"}},
        {},   # empty label map
    )
    assert got[0]["category_label"] == "Cold Storage"


# ── _kitchen_cat_pct ─────────────────────────────────────────────────
def test_cat_pct_empty_returns_empty_list():
    assert _kitchen_cat_pct({}, CAT_LABEL) == []


def test_cat_pct_computes_percentage_and_rounds_1dp():
    got = _kitchen_cat_pct({"grocery": 300.0, "vegetable": 100.0}, CAT_LABEL)
    assert got == [
        {"key": "grocery",   "label": "Grocery",   "amount": 300.0, "pct": 75.0},
        {"key": "vegetable", "label": "Vegetable", "amount": 100.0, "pct": 25.0},
    ]


def test_cat_pct_sorted_by_amount_desc():
    got = _kitchen_cat_pct(
        {"vegetable": 100.0, "grocery": 300.0}, CAT_LABEL,
    )
    assert [r["key"] for r in got] == ["grocery", "vegetable"]


def test_cat_pct_falls_back_to_titled_key_when_missing_label():
    got = _kitchen_cat_pct({"cold_storage": 42.0}, {})
    assert got[0]["label"] == "Cold Storage"
    assert got[0]["pct"] == 100.0


def test_cat_pct_all_zero_denominator_is_safe():
    """Empty window can have all-zero category totals — divisor floor
    of 1.0 avoids ZeroDivisionError and yields 0% rows."""
    got = _kitchen_cat_pct({"grocery": 0.0}, CAT_LABEL)
    assert got[0]["pct"] == 0.0
