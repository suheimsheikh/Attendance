/**
 * MealEntryTab — unified daily entry (Feb 2026 rev).
 *
 * Replaces the split "Purchases" and "Daily issues" tabs. One grid, one
 * row per item, with columns for both the supplier purchase (qty · rate ·
 * amount) AND the kitchen issue (qty) on the same line. The chef enters
 * everything for a day without switching tabs.
 *
 * Key behaviours (per the Feb 2026 spec):
 *  • Auto-save on blur — no Save button. Debounced (350ms) full-doc PUT.
 *  • Category headers rendered with a warm yellow band + bold font so
 *    they visually anchor scans down a long grocery list.
 *  • Day navigator has back / forward arrows for prev / next day.
 *  • On-hand column shows stock at end of the PREVIOUS day so the chef
 *    can sanity-check whether an issue is even possible.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, Check, Boxes } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
const inr = (n) =>
  n == null ? "0" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const fmtQty = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

export default function MealEntryTab() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [stock, setStock] = useState({});      // item_id → on_hand (end of prev day)
  const [avgRate, setAvgRate] = useState({});  // item_id → weighted-avg cost (₹ / unit)
  const [purch, setPurch] = useState({});      // item_id → { qty, rate }
  const [issues, setIssues] = useState({});    // item_id → qty
  const [saving, setSaving] = useState({ purch: false, issues: false });
  const [savedAt, setSavedAt] = useState(null); // last successful save timestamp

  // ---------------------------------------------------------------------
  // Load masters once. Item / category list stays stable across day nav.
  // ---------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [c, i] = await Promise.all([
          api.get("/meals/purchase-categories"),
          api.get("/meals/items?include_inactive=false"),
        ]);
        setCats((c.categories || []).filter((x) => x.active !== false));
        setItems(i.items || []);
      } catch (err) { showApiError(err, "Couldn't load pantry masters"); }
    })();
  }, []);

  // ---------------------------------------------------------------------
  // Load the day's purchases, issues, and previous-day stock whenever the
  // selected date changes. Purchases and issues live in separate Mongo
  // collections but share the same `date` key.
  // ---------------------------------------------------------------------
  useEffect(() => {
    api.get(`/meals/purchases?start=${dateStr}&end=${dateStr}`)
      .then((r) => {
        const lines = r.purchases?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = { qty: l.qty, rate: l.rate }; });
        setPurch(next);
      })
      .catch(() => setPurch({}));

    api.get(`/meals/issues?start=${dateStr}&end=${dateStr}`)
      .then((r) => {
        const lines = r.issues?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = l.qty; });
        setIssues(next);
      })
      .catch(() => setIssues({}));

    // On-hand at end of previous day = what the chef physically has at
    // the start of today's cooking (used only as a sanity check on the
    // Issue column).
    api.get(`/meals/stock?as_of=${addDays(dateStr, -1)}`)
      .then((r) => setStock(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.on_hand]))))
      .catch(() => setStock({}));
    // Weighted-average purchase cost — as of TODAY so a purchase entered
    // this morning immediately flows into the same day's issue valuation.
    // Refetched after every purchase save (see flushPurchases below).
    api.get(`/meals/stock?as_of=${dateStr}`)
      .then((r) => setAvgRate(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.avg_rate || 0]))))
      .catch(() => setAvgRate({}));
  }, [dateStr]);

  // Standalone refresher for the avg-rate map — called after a purchase
  // save so the Issue Rate / Amount columns update without needing a
  // full page reload.
  const refreshAvgRate = () => {
    api.get(`/meals/stock?as_of=${dateStr}`)
      .then((r) => setAvgRate(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.avg_rate || 0]))))
      .catch(() => {});
  };

  // ---------------------------------------------------------------------
  // Auto-save. Each half (purchases / issues) has its own debounce so a
  // rate-only edit doesn't re-write the issues doc unnecessarily. The
  // ref maps hold the latest values across renders so the timeout callback
  // sees fresh state without re-arming on every keystroke.
  // ---------------------------------------------------------------------
  const purchTimer = useRef(null);
  const issuesTimer = useRef(null);
  const latestPurch = useRef(purch);
  const latestIssues = useRef(issues);
  useEffect(() => { latestPurch.current = purch; }, [purch]);
  useEffect(() => { latestIssues.current = issues; }, [issues]);

  const flushPurchases = async () => {
    setSaving((s) => ({ ...s, purch: true }));
    const lines = items
      .map((it) => {
        const e = latestPurch.current[it.id];
        const qty = num(e?.qty);
        const rate = num(e?.rate);
        if (qty <= 0 && rate <= 0) return null;
        return { item_id: it.id, qty, rate };
      })
      .filter(Boolean);
    try {
      await api.put(`/meals/purchases/${dateStr}`, { lines });
      setSavedAt(Date.now());
      // Purchases just changed → weighted-avg rate for this day changed
      // → issue amounts on this same screen must update.
      refreshAvgRate();
    } catch (err) {
      showApiError(err, "Couldn't auto-save purchases");
    } finally {
      setSaving((s) => ({ ...s, purch: false }));
    }
  };
  const flushIssues = async () => {
    setSaving((s) => ({ ...s, issues: true }));
    const lines = items
      .filter((it) => num(latestIssues.current[it.id]) > 0)
      .map((it) => ({ item_id: it.id, qty: num(latestIssues.current[it.id]) }));
    try {
      await api.put(`/meals/issues/${dateStr}`, { lines });
      setSavedAt(Date.now());
      // Refresh on-hand so any subsequent issue lines see the new stock
      // (an issue lowers next-day opening — but for TODAY's grid the
      // "on-hand" is prev-day, so refresh isn't needed here. Skipped.)
    } catch (err) {
      showApiError(err, "Couldn't auto-save issues");
    } finally {
      setSaving((s) => ({ ...s, issues: false }));
    }
  };

  const queuePurch = () => {
    clearTimeout(purchTimer.current);
    purchTimer.current = setTimeout(flushPurchases, 350);
  };
  const queueIssues = () => {
    clearTimeout(issuesTimer.current);
    issuesTimer.current = setTimeout(flushIssues, 350);
  };

  const setPurchField = (itemId, field, value) => {
    setPurch((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [field]: value } }));
  };

  // ---------------------------------------------------------------------
  // Group items by category for the grid layout. Only categories that
  // actually own at least one item show up.
  // ---------------------------------------------------------------------
  const grouped = useMemo(() => {
    const m = new Map(cats.map((c) => [c.key, { cat: c, rows: [] }]));
    items.forEach((it) => m.get(it.category_key)?.rows.push(it));
    return Array.from(m.values()).filter((g) => g.rows.length > 0);
  }, [items, cats]);

  const dayTotal = useMemo(() => {
    let s = 0;
    for (const it of items) {
      const e = purch[it.id];
      s += num(e?.qty) * num(e?.rate);
    }
    return s;
  }, [items, purch]);

  // Day-wide issue value = Σ (issued_qty × item's weighted-avg cost).
  const issueDayTotal = useMemo(() => {
    let s = 0;
    for (const it of items) {
      s += num(issues[it.id]) * (avgRate[it.id] || 0);
    }
    return s;
  }, [items, issues, avgRate]);

  const nextDate = addDays(dateStr, +1);
  const canGoForward = nextDate <= todayISO();

  return (
    <div data-testid="meal-entry-tab">
      {/* Date navigator */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={() => setDateStr(addDays(dateStr, -1))}
          className="iu-btn-secondary !h-9 !w-9 !p-0"
          title="Previous day"
          data-testid="entry-prev-day"
        ><ChevronLeft size={16}/></button>
        <input
          type="date"
          value={dateStr}
          max={todayISO()}
          onChange={(e) => setDateStr(e.target.value)}
          className="iu-input !h-9 !w-auto text-sm"
          data-testid="entry-date"
        />
        <button
          onClick={() => canGoForward && setDateStr(nextDate)}
          disabled={!canGoForward}
          className="iu-btn-secondary !h-9 !w-9 !p-0 disabled:opacity-40 disabled:cursor-not-allowed"
          title={canGoForward ? "Next day" : "Can't go past today"}
          data-testid="entry-next-day"
        ><ChevronRight size={16}/></button>
        <span className="text-sm font-semibold text-slate-700">{formatDate(dateStr)}</span>

        {/* Save indicator — silent when idle, spinner while flushing,
            tick immediately after a successful save (auto-clears after
            a couple of seconds). */}
        <span className="ml-auto text-xs inline-flex items-center gap-1" data-testid="entry-save-indicator">
          {(saving.purch || saving.issues) ? (
            <span className="text-slate-500 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin"/> Saving…</span>
          ) : savedAt && (Date.now() - savedAt) < 3000 ? (
            <span className="text-emerald-600 inline-flex items-center gap-1"><Check size={12}/> Saved</span>
          ) : (
            <span className="text-slate-400">Auto-saves as you type</span>
          )}
        </span>
      </div>

      {grouped.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="entry-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2"/>
          <p className="font-semibold text-slate-700">No items configured yet.</p>
          <p className="text-sm text-slate-500 mt-1">Ask an admin to add items in the Masters tab.</p>
        </div>
      ) : (
        <div className="iu-card overflow-hidden" data-testid="entry-grid-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 sticky top-0 z-10">
              <tr>
                <th className="text-left p-2 w-1/4">Item</th>
                <th className="text-left p-2 w-14">Unit</th>
                <th className="text-right p-2 w-24" title="Stock on hand at end of previous day">On-hand</th>
                <th className="text-right p-2 w-24 border-l border-slate-200 text-emerald-600">Purch qty</th>
                <th className="text-right p-2 w-24 text-emerald-600">Rate ₹</th>
                <th className="text-right p-2 w-28 text-emerald-700">Amount ₹</th>
                <th className="text-right p-2 w-24 border-l border-slate-200 text-amber-600">Issue qty</th>
                <th className="text-right p-2 w-24 text-amber-600" title="Weighted-average purchase cost — auto-calculated, not editable">Rate ₹</th>
                <th className="text-right p-2 w-28 text-amber-700">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ cat, rows }) => (
                <React.Fragment key={cat.key}>
                  {/* Category header — warm yellow band + bold uppercase
                      label. Requested Feb 2026 to visually anchor scans. */}
                  <tr className="bg-amber-100 border-y border-amber-200" data-testid={`entry-cat-header-${cat.key}`}>
                    <td colSpan={9} className="px-2 py-1.5 text-xs font-extrabold text-amber-900 uppercase tracking-wider">
                      {cat.label}
                    </td>
                  </tr>
                  {rows.map((it) => {
                    const e = purch[it.id] || {};
                    const purchAmt = num(e.qty) * num(e.rate);
                    const oh = stock[it.id];
                    const issueQty = issues[it.id];
                    const rate = avgRate[it.id] || 0;
                    const issueAmt = num(issueQty) * rate;
                    const over = oh != null && num(issueQty) > oh + 1e-6;
                    return (
                      <tr key={it.id} className={`border-t border-slate-100 hover:bg-slate-50/70 ${over ? "bg-rose-50/60" : ""}`} data-testid={`entry-row-${it.id}`}>
                        <td className="p-2 font-semibold text-slate-900">{it.name}</td>
                        <td className="p-2 text-slate-500 text-xs">{it.unit}</td>
                        <td className="p-2 text-right tabular-nums text-slate-600" data-testid={`entry-onhand-${it.id}`}>
                          {oh != null ? fmtQty(oh) : "—"}
                        </td>
                        <td className="p-2 border-l border-slate-100">
                          <input
                            type="number" min="0" step="0.01"
                            value={e.qty ?? ""}
                            onChange={(ev) => setPurchField(it.id, "qty", ev.target.value)}
                            onBlur={queuePurch}
                            className="iu-input !h-8 text-sm w-full text-right tabular-nums"
                            placeholder="0"
                            data-testid={`entry-purch-qty-${it.id}`}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number" min="0" step="0.01"
                            value={e.rate ?? ""}
                            onChange={(ev) => setPurchField(it.id, "rate", ev.target.value)}
                            onBlur={queuePurch}
                            className="iu-input !h-8 text-sm w-full text-right tabular-nums"
                            placeholder="0"
                            data-testid={`entry-purch-rate-${it.id}`}
                          />
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums text-emerald-700" data-testid={`entry-purch-amt-${it.id}`}>
                          {purchAmt > 0 ? `₹${inr(purchAmt)}` : ""}
                        </td>
                        <td className="p-2 border-l border-slate-100">
                          <input
                            type="number" min="0" step="0.01"
                            value={issueQty ?? ""}
                            onChange={(ev) => setIssues({ ...issues, [it.id]: ev.target.value })}
                            onBlur={queueIssues}
                            className={`iu-input !h-8 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`}
                            placeholder="0"
                            data-testid={`entry-issue-qty-${it.id}`}
                            title={over ? "Issue exceeds on-hand — will drive stock negative" : ""}
                          />
                        </td>
                        {/* Issue Rate — weighted-avg purchase cost, read-only.
                            Chef doesn't type this; it's inherited from history. */}
                        <td className="p-2 text-right tabular-nums text-slate-500 text-xs" data-testid={`entry-issue-rate-${it.id}`} title="Weighted-average purchase cost across all recorded purchases">
                          {rate > 0 ? `₹${inr(rate)}` : "—"}
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums text-amber-700" data-testid={`entry-issue-amt-${it.id}`}>
                          {issueAmt > 0 ? `₹${inr(issueAmt)}` : ""}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t-2 border-slate-200">
              <tr>
                <td colSpan={5} className="p-3 text-right font-bold text-slate-600">Day purchase total</td>
                <td className="p-3 text-right text-lg font-extrabold tabular-nums text-emerald-700" data-testid="entry-day-total">
                  ₹{inr(dayTotal)}
                </td>
                <td colSpan={2} className="p-3 text-right font-bold text-slate-600">Day issue total</td>
                <td className="p-3 text-right text-lg font-extrabold tabular-nums text-amber-700" data-testid="entry-day-issue-total">
                  ₹{inr(issueDayTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
