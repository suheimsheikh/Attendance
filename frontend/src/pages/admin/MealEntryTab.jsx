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
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Loader2, Check, Boxes, Filter, Printer, X, CalendarRange, Search } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { isUserEditing } from "../../hooks/useMealsEvents";

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

/**
 * Per-item vendor override on the Daily-entry grid (Aug 2026 user
 * request — "sometimes different vendors for different items in the
 * same category on the same day, but only sometimes").
 *
 * Behaviour:
 *   • Collapsed state — just a tiny "same as category" hint (dim) OR
 *     an amber "override → Vendor X" chip if the row already differs
 *     from the category default. Never clutters the row.
 *   • Clicking either state expands an inline <select> so the chef can
 *     pick a different supplier for this one item. Choosing the same
 *     value as the category default clears the override.
 *   • The category-header picker still bulk-sets the vendor for every
 *     row; overrides are only shown when the row was explicitly
 *     pointed elsewhere.
 */
function RowVendorPicker({ rowVendorId, catVendorId, vendors, onChange, onAddNew, testid }) {
  const [open, setOpen] = React.useState(false);
  // Row is "overriding" when it has an explicit vendor different from
  // the category default. An empty catVendorId + non-empty rowVendorId
  // also counts as override (row has a vendor, category doesn't).
  const isOverride = rowVendorId && rowVendorId !== catVendorId;
  const rowVendor = vendors.find((v) => v.id === rowVendorId);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-0.5 text-[10px] leading-tight inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-slate-100 ${
          isOverride ? "text-amber-700 font-semibold" : "text-slate-400"
        }`}
        data-testid={testid}
        title={isOverride
          ? "This row uses a different supplier from the category default. Click to change."
          : "Same supplier as the category default. Click to override for this item only."}
      >
        {isOverride
          ? <>↳ {rowVendor?.name || "unknown vendor"}</>
          : "↳ same as category"}
      </button>
    );
  }
  return (
    <select
      autoFocus
      value={rowVendorId || ""}
      onBlur={() => setOpen(false)}
      onChange={(ev) => {
        const v = ev.target.value;
        if (v === "__add__") { onAddNew(); setOpen(false); return; }
        // Choosing the same value as the category default clears the
        // per-row override so the row stops looking "overridden".
        onChange(v === catVendorId ? "" : v);
        setOpen(false);
      }}
      className="mt-0.5 h-6 text-[11px] w-full max-w-[220px] bg-white border border-emerald-200 rounded px-1 text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-400"
      data-testid={`${testid}-select`}
    >
      <option value="">— use category default —</option>
      {vendors.map((v) => (
        <option key={v.id} value={v.id}>{v.name}</option>
      ))}
      <option value="__add__">＋ Add new vendor…</option>
    </select>
  );
}

export default function MealEntryTab({ liveSig }) {
  const [dateStr, setDateStr] = useState(todayISO());
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [stock, setStock] = useState({});      // item_id → on_hand (end of prev day)
  const [avgRate, setAvgRate] = useState({});  // item_id → weighted-avg cost (₹ / unit)
  const [purch, setPurch] = useState({});      // item_id → { qty, rate, vendor_id }
  const [issues, setIssues] = useState({});    // item_id → qty
  const [vendors, setVendors] = useState([]);  // {id, name, phone}[]
  const [showAddVendor, setShowAddVendor] = useState(null); // category_key on demand
  const [saving, setSaving] = useState({ purch: false, issues: false });
  const [savedAt, setSavedAt] = useState(null); // last successful save timestamp
  // Show only rows where either purch qty OR issue qty is > 0 — handy on
  // busy days when the pantry list is long but the chef only touched a
  // handful of items and wants to verify their entries at a glance.
  const [nonZeroOnly, setNonZeroOnly] = useState(false);
  // Free-text item filter (Aug 2026 user request). Case-insensitive
  // substring match against item name; categories with no matching
  // items are hidden entirely to keep the grid clean.
  const [search, setSearch] = useState("");
  // Category keys that are user-collapsed on this device. Persisted in
  // localStorage so a chef's preferred fold state survives reloads.
  // Added 19 Aug 2026 (user asked for collapsible category sections).
  const [collapsedCats, setCollapsedCats] = useState(() => {
    try {
      const raw = localStorage.getItem("mealEntry.collapsedCats");
      return new Set(raw ? JSON.parse(raw) : []);
    } catch { return new Set(); }
  });
  const toggleCat = (key) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem("mealEntry.collapsedCats", JSON.stringify([...next])); } catch { /* storage blocked → not fatal */ }
      return next;
    });
  };
  // Date-wise totals drill-down: opened by double-clicking either the
  // Purchases or the Issues day-total card. `historyKind` picks which
  // column is emphasised in the modal ('purchase' | 'issue').
  const [historyKind, setHistoryKind] = useState(null);

  // ---------------------------------------------------------------------
  // Load masters once. Item / category list stays stable across day nav
  // (re-fetched only when a live signal says another machine changed them).
  // ---------------------------------------------------------------------
  const loadMasters = async () => {
    try {
      const [c, i, v] = await Promise.all([
        api.get("/meals/purchase-categories"),
        api.get("/meals/items?include_inactive=false"),
        api.get("/meals/vendors"),
      ]);
      setCats((c.categories || []).filter((x) => x.active !== false));
      setItems(i.items || []);
      setVendors(v.vendors || []);
    } catch (err) { showApiError(err, "Couldn't load pantry masters"); }
  };
  useEffect(() => { loadMasters(); }, []);

  // Re-fetch vendors on demand (e.g. after inline "Add vendor" flow).
  const refreshVendors = () => {
    api.get("/meals/vendors").then((r) => setVendors(r.vendors || [])).catch(() => {});
  };

  // ---------------------------------------------------------------------
  // Load the day's purchases, issues, and previous-day stock whenever the
  // selected date changes. Purchases and issues live in separate Mongo
  // collections but share the same `date` key.
  // ---------------------------------------------------------------------
  // Token guards against out-of-order GET responses on rapid day flips —
  // only the latest date's responses get applied to state.
  const loadToken = useRef(0);
  const dateRef = useRef(dateStr);
  useEffect(() => { dateRef.current = dateStr; }, [dateStr]);
  // Loads one day's purchases / issues / stock / avg-rate. Reused by the
  // dateStr effect AND the live-update signal handler below.
  const loadDay = (d) => {
    const token = ++loadToken.current;
    const fresh = () => loadToken.current === token;
    api.get(`/meals/purchases?start=${d}&end=${d}`)
      .then((r) => {
        if (!fresh()) return;
        const lines = r.purchases?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = { qty: l.qty, rate: l.rate, vendor_id: l.vendor_id || "" }; });
        setPurch(next);
      })
      .catch(() => { if (fresh()) setPurch({}); });

    api.get(`/meals/issues?start=${d}&end=${d}`)
      .then((r) => {
        if (!fresh()) return;
        const lines = r.issues?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = l.qty; });
        setIssues(next);
      })
      .catch(() => { if (fresh()) setIssues({}); });

    // On-hand at end of previous day = what the chef physically has at
    // the start of today's cooking (used only as a sanity check on the
    // Issue column).
    api.get(`/meals/stock?as_of=${addDays(d, -1)}`)
      .then((r) => { if (fresh()) setStock(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.on_hand]))); })
      .catch(() => { if (fresh()) setStock({}); });
    // Weighted-average purchase cost — as of the day so a purchase entered
    // this morning immediately flows into the same day's issue valuation.
    api.get(`/meals/stock?as_of=${d}`)
      .then((r) => { if (fresh()) setAvgRate(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.avg_rate || 0]))); })
      .catch(() => { if (fresh()) setAvgRate({}); });
  };
  useEffect(() => {
    loadDay(dateStr);

    // Before this day's view is replaced (day nav) or unmounted (tab
    // switch), flush any pending debounced save FOR THIS DAY. This
    // cleanup runs before the next day's data loads, so the refs still
    // hold this day's lines — preventing a blur + immediate day-nav from
    // writing the NEW day's lines onto the OLD date.
    return () => {
      if (purchTimer.current) { clearTimeout(purchTimer.current); purchTimer.current = null; flushPurchases(dateStr); }
      if (issuesTimer.current) { clearTimeout(issuesTimer.current); issuesTimer.current = null; flushIssues(dateStr); }
    };
  }, [dateStr]);

  // ---------------------------------------------------------------------
  // Live refresh — the server pushes a signal (SSE) when ANOTHER machine
  // changes pantry data. Deferred while a save is pending/in-flight or
  // the user is typing so it never clobbers an in-progress edit.
  // ---------------------------------------------------------------------
  const savingRef = useRef(saving);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => {
    if (!liveSig) return;
    if (!["purchases", "issues", "wastage", "items", "categories", "vendors"].includes(liveSig.scope)) return;
    if (liveSig.scope === "vendors") { refreshVendors(); return; }
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      const busy = savingRef.current.purch || savingRef.current.issues ||
        purchTimer.current || issuesTimer.current ||
        pendingSave.current.purch || pendingSave.current.issues;
      if (busy || isUserEditing()) { setTimeout(attempt, 4000); return; }
      if (liveSig.scope === "items" || liveSig.scope === "categories") loadMasters();
      loadDay(dateRef.current);
    };
    attempt();
    return () => { cancelled = true; };
  }, [liveSig]);

  // Standalone refresher for the avg-rate map — called after a purchase
  // save so the Issue Rate / Amount columns update without needing a
  // full page reload. Ignored if the user has navigated to another day
  // by the time the response lands.
  const refreshAvgRate = (targetDate) => {
    api.get(`/meals/stock?as_of=${targetDate}`)
      .then((r) => {
        if (dateRef.current !== targetDate) return;
        setAvgRate(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.avg_rate || 0])));
      })
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

  // Serialised save chains — a new save NEVER interrupts one already in
  // flight (user request, Aug 2026). Each flush snapshots its payload
  // synchronously (so it belongs to the right day) and then queues the
  // network PUT behind whatever save is currently running, guaranteeing
  // in-order arrival at the server. Consecutive queued saves for the
  // same date coalesce to the latest snapshot.
  const saveChain = useRef({ purch: Promise.resolve(), issues: Promise.resolve() });
  const pendingSave = useRef({ purch: null, issues: null }); // seq de-dupe
  const saveSeq = useRef({ purch: 0, issues: 0 });

  // Both flushes take the TARGET date explicitly (captured at queue time)
  // so the PUT URL always matches the day the lines belong to, even if
  // the user has since navigated to another day.
  const flushPurchases = (targetDate) => {
    // Snapshot NOW — refs still hold this day's lines at call time.
    const lines = items
      .map((it) => {
        const e = latestPurch.current[it.id];
        const qty = num(e?.qty);
        const rate = num(e?.rate);
        if (qty <= 0 && rate <= 0) return null;
        return { item_id: it.id, qty, rate, vendor_id: e?.vendor_id || null };
      })
      .filter(Boolean);
    const seq = ++saveSeq.current.purch;
    pendingSave.current.purch = { seq, targetDate, lines };
    const run = async () => {
      const p = pendingSave.current.purch;
      // A newer snapshot for the SAME date superseded this one while we
      // waited in the chain — skip; the newer queued run will send it.
      if (!p || (p.seq !== seq && p.targetDate === targetDate)) return;
      const mine = p.seq === seq;
      const payload = mine ? p : { targetDate, lines };
      if (mine) pendingSave.current.purch = null;
      setSaving((s) => ({ ...s, purch: true }));
      try {
        await api.put(`/meals/purchases/${payload.targetDate}`, { lines: payload.lines });
        setSavedAt(Date.now());
        // Purchases just changed → weighted-avg rate changed → issue
        // amounts on the currently displayed day must update.
        refreshAvgRate(dateRef.current);
      } catch (err) {
        showApiError(err, "Couldn't auto-save purchases");
      } finally {
        setSaving((s) => ({ ...s, purch: false }));
      }
    };
    saveChain.current.purch = saveChain.current.purch.then(run, run);
    return saveChain.current.purch;
  };
  const flushIssues = (targetDate) => {
    const lines = items
      .filter((it) => num(latestIssues.current[it.id]) > 0)
      .map((it) => ({ item_id: it.id, qty: num(latestIssues.current[it.id]) }));
    const seq = ++saveSeq.current.issues;
    pendingSave.current.issues = { seq, targetDate, lines };
    const run = async () => {
      const p = pendingSave.current.issues;
      if (!p || (p.seq !== seq && p.targetDate === targetDate)) return;
      const mine = p.seq === seq;
      const payload = mine ? p : { targetDate, lines };
      if (mine) pendingSave.current.issues = null;
      setSaving((s) => ({ ...s, issues: true }));
      try {
        await api.put(`/meals/issues/${payload.targetDate}`, { lines: payload.lines });
        setSavedAt(Date.now());
      } catch (err) {
        showApiError(err, "Couldn't auto-save issues");
      } finally {
        setSaving((s) => ({ ...s, issues: false }));
      }
    };
    saveChain.current.issues = saveChain.current.issues.then(run, run);
    return saveChain.current.issues;
  };

  const queuePurch = () => {
    clearTimeout(purchTimer.current);
    const d = dateStr;
    purchTimer.current = setTimeout(() => { purchTimer.current = null; flushPurchases(d); }, 350);
  };
  const queueIssues = () => {
    clearTimeout(issuesTimer.current);
    const d = dateStr;
    issuesTimer.current = setTimeout(() => { issuesTimer.current = null; flushIssues(d); }, 350);
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

  // Applied view — hides zero-qty rows when the filter is on. A category
  // is hidden entirely once it has no visible rows so the header doesn't
  // stand alone above nothing. Each group also carries per-category
  // subtotals so the header row can surface them (Aug 2026 request).
  const isTouched = (it) => num(purch[it.id]?.qty) > 0 || num(purch[it.id]?.rate) > 0 || num(issues[it.id]) > 0;
  const filteredGrouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bySearch = q
      ? grouped
          .map(({ cat, rows }) => ({ cat, rows: rows.filter((it) => (it.name || "").toLowerCase().includes(q)) }))
          .filter((g) => g.rows.length > 0)
      : grouped;
    const base = nonZeroOnly
      ? bySearch
          .map(({ cat, rows }) => ({ cat, rows: rows.filter(isTouched) }))
          .filter((g) => g.rows.length > 0)
      : bySearch;
    return base.map(({ cat, rows }) => {
      let pAmt = 0, iAmt = 0;
      // Category vendor consensus — the shared value across every
      // non-empty row. `mixed` = true when at least two rows point at
      // different vendors (i.e. per-row overrides exist).
      const rowVs = new Set();
      for (const it of rows) {
        const e = purch[it.id] || {};
        pAmt += num(e.qty) * num(e.rate);
        iAmt += num(issues[it.id]) * (avgRate[it.id] || 0);
        if (e.vendor_id) rowVs.add(e.vendor_id);
      }
      const catVendor = rowVs.size === 1 ? [...rowVs][0] : "";
      const mixed = rowVs.size > 1;
      return { cat, rows, purchAmt: pAmt, issueAmt: iAmt, catVendor, mixed };
    });
  }, [grouped, nonZeroOnly, purch, issues, avgRate, search]);

  // Set (or clear) the vendor for items in a category on the current
  // day. Rows that already point at a different vendor (an explicit
  // per-row override, Aug 2026) are LEFT ALONE — only rows currently
  // matching the outgoing category vendor (or unset) are re-pointed.
  // Save is deferred via the existing debounce so bulk dropdown
  // changes don't hammer the PUT endpoint.
  const setCategoryVendor = (catKey, vendorId) => {
    setPurch((prev) => {
      // Detect the outgoing "category consensus" vendor — the value
      // shared by every non-empty row in the category. If rows disagree
      // (some already overridden) we treat consensus as empty so we
      // only touch the truly-blank rows.
      const catItems = items.filter((it) => it.category_key === catKey);
      const rowVendors = new Set(
        catItems.map((it) => prev[it.id]?.vendor_id).filter(Boolean)
      );
      const outgoing = rowVendors.size === 1 ? [...rowVendors][0] : "";
      const next = { ...prev };
      catItems.forEach((it) => {
        const current = next[it.id]?.vendor_id || "";
        if (current === "" || current === outgoing) {
          next[it.id] = { ...(next[it.id] || {}), vendor_id: vendorId || "" };
        }
        // else: row is an explicit override — preserve it.
      });
      return next;
    });
    queuePurch();
  };

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
      {/* Everything above the item list stays latched to the top while
          the chef scrolls a long grocery grid — day navigator, save
          indicator, per-day totals, PURCHASES/ISSUES group header AND
          column labels. Wrapped in one sticky div so nav + totals move
          as a unit; the thead below uses a matching `top` offset so it
          stacks cleanly under this block. */}
      <div className="sticky top-[104px] z-30 bg-slate-50 pb-3 -mx-4 md:-mx-8 px-4 md:px-8" data-testid="entry-sticky-top">
        <div className="flex items-center gap-2 pt-1 pb-2 flex-wrap">
          <button
            onClick={() => setDateStr(addDays(dateStr, -1))}
            className="group h-10 w-10 rounded-xl bg-gradient-to-br from-slate-800 to-slate-700 text-white shadow-md ring-1 ring-slate-900/10 hover:from-slate-900 hover:to-slate-800 hover:shadow-lg hover:-translate-x-0.5 active:translate-x-0 active:scale-95 transition-all inline-flex items-center justify-center"
            title="Previous day"
            data-testid="entry-prev-day"
          ><ChevronLeft size={20} className="stroke-[2.5]"/></button>
          <input
            type="date"
            value={dateStr}
            max={todayISO()}
            onChange={(e) => setDateStr(e.target.value)}
            className="iu-input !h-10 !w-auto text-sm font-semibold"
            data-testid="entry-date"
          />
          <button
            onClick={() => canGoForward && setDateStr(nextDate)}
            disabled={!canGoForward}
            className="group h-10 w-10 rounded-xl bg-gradient-to-br from-slate-800 to-slate-700 text-white shadow-md ring-1 ring-slate-900/10 hover:from-slate-900 hover:to-slate-800 hover:shadow-lg hover:translate-x-0.5 active:translate-x-0 active:scale-95 transition-all inline-flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-x-0 disabled:hover:shadow-md"
            title={canGoForward ? "Next day" : "Can't go past today"}
            data-testid="entry-next-day"
          ><ChevronRight size={20} className="stroke-[2.5]"/></button>
          <span className="text-sm font-semibold text-slate-700">{formatDate(dateStr)}</span>

          <div className="ml-4 relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"/>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item…"
              className="iu-input !h-9 !pl-8 !pr-7 !w-52 text-sm"
              data-testid="entry-search"
              title="Filter the grid by item name"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-slate-200 text-slate-500"
                data-testid="entry-search-clear"
                title="Clear search"
              ><X size={12}/></button>
            )}
          </div>

          <label className="ml-2 inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer" title="Hide items with no purchases and no issues today">
            <input
              type="checkbox"
              checked={nonZeroOnly}
              onChange={(e) => setNonZeroOnly(e.target.checked)}
              data-testid="entry-nonzero-toggle"
            />
            <Filter size={12}/> Only touched rows
          </label>

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

        <div className="grid grid-cols-2 gap-3" data-testid="entry-totals-bar">
          <div
            className="iu-card p-2.5 flex items-center justify-between border-emerald-200 bg-emerald-50/60 cursor-pointer hover:bg-emerald-50 hover:border-emerald-300 select-none transition"
            onDoubleClick={() => setHistoryKind("purchase")}
            title="Double-click to see date-wise purchase totals and download a PDF"
            data-testid="entry-purchase-total-card"
          >
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
              Purchases · Day total
              <span className="ml-1 text-[9px] font-normal text-emerald-600/80 normal-case tracking-normal">(dbl-click for history)</span>
            </span>
            <span className="text-lg font-extrabold tabular-nums text-emerald-800" data-testid="entry-day-total">₹{inr(dayTotal)}</span>
          </div>
          <div
            className="iu-card p-2.5 flex items-center justify-between border-amber-200 bg-amber-50/60 cursor-pointer hover:bg-amber-50 hover:border-amber-300 select-none transition"
            onDoubleClick={() => setHistoryKind("issue")}
            title="Double-click to see date-wise issue totals and download a PDF"
            data-testid="entry-issue-total-card"
          >
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
              Issues · Day total
              <span className="ml-1 text-[9px] font-normal text-amber-600/80 normal-case tracking-normal">(dbl-click for history)</span>
            </span>
            <span className="text-lg font-extrabold tabular-nums text-amber-800" data-testid="entry-day-issue-total">₹{inr(issueDayTotal)}</span>
          </div>
        </div>
      </div>

      {historyKind && (
        <DailyTotalsHistoryModal
          kind={historyKind}
          selectedDate={dateStr}
          onClose={() => setHistoryKind(null)}
        />
      )}

      {filteredGrouped.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="entry-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2"/>
          <p className="font-semibold text-slate-700">
            {search
              ? `No items match "${search}".`
              : nonZeroOnly ? "No purchases or issues entered yet for this day." : "No items configured yet."}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {search
              ? "Try a different word or clear the search."
              : nonZeroOnly ? "Turn off \"Only touched rows\" to enter values." : "Ask an admin to add items in the Masters tab."}
          </p>
        </div>
      ) : (
        // `overflow-hidden` on the card would break sticky positioning
        // for the thead. Use `overflow-clip` around the rounded corners
        // via the inner card style instead — but not on this wrapper.
        <div className="iu-card" data-testid="entry-grid-card">
          <table className="w-full text-sm">
            <thead className="sticky top-[216px] z-20 shadow-sm">
              {/* Group-header row: visually splits the grid into a
                  PURCHASES half (emerald) and an ISSUES half (amber) so
                  chefs immediately see which side of the row they're in.
                  Requested Feb 2026. */}
              <tr data-testid="entry-group-header">
                <th colSpan={3} className="bg-slate-100 border-b border-slate-200"/>
                <th colSpan={3} className="bg-emerald-600 text-white text-[11px] font-extrabold uppercase tracking-wider px-3 py-1.5 border-b border-emerald-700 text-left">
                  ↓ Purchases
                </th>
                <th colSpan={3} className="bg-amber-500 text-white text-[11px] font-extrabold uppercase tracking-wider px-3 py-1.5 border-b border-amber-600 text-left">
                  ↓ Issues
                </th>
              </tr>
              <tr className="bg-slate-50 text-[11px] uppercase text-slate-500">
                <th className="text-left p-2 w-1/4">Item</th>
                <th className="text-left p-2 w-14">Unit</th>
                <th className="text-right p-2 w-24" title="Stock on hand at end of previous day">On-hand</th>
                <th className="text-right p-2 w-24 border-l-2 border-emerald-500 bg-emerald-50/70">Qty</th>
                <th className="text-right p-2 w-24 bg-emerald-50/70">Rate ₹</th>
                <th className="text-right p-2 w-28 bg-emerald-50/70">Amount ₹</th>
                <th className="text-right p-2 w-24 border-l-2 border-amber-500 bg-amber-50/70">Qty</th>
                <th className="text-right p-2 w-24 bg-amber-50/70" title="Weighted-average purchase cost — auto-calculated, not editable">Rate ₹</th>
                <th className="text-right p-2 w-28 bg-amber-50/70">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {filteredGrouped.map(({ cat, rows, purchAmt, issueAmt, catVendor, mixed }) => {
                const isCollapsed = collapsedCats.has(cat.key);
                return (
                <React.Fragment key={cat.key}>
                  {/* Category header — bright yellow band + bold uppercase
                      label with a supplier picker and per-category
                      subtotals for both sides.  Aug 2026 request. */}
                  <tr
                    className="bg-amber-100 border-y border-amber-300 select-none"
                    data-testid={`entry-cat-header-${cat.key}`}
                  >
                    <td
                      colSpan={3}
                      className="px-2 py-1.5 cursor-pointer hover:bg-amber-200/60"
                      onClick={() => toggleCat(cat.key)}
                      title={isCollapsed ? "Click to expand this category" : "Click to collapse this category"}
                    >
                      <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-amber-900 uppercase tracking-wider">
                        {isCollapsed
                          ? <ChevronRight size={14} className="stroke-[3]"/>
                          : <ChevronDown size={14} className="stroke-[3]"/>}
                        {cat.label}
                        <span className="ml-1 text-[10px] font-semibold text-amber-800/70 normal-case tracking-normal">
                          ({rows.length} item{rows.length === 1 ? "" : "s"})
                        </span>
                      </span>
                    </td>
                    <td colSpan={3} className="px-2 py-1.5">
                      {/* Vendor picker — one supplier per category per day.
                          Selecting a value propagates the vendor_id to
                          every row's purchase line on the next save. */}
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <span className="text-[10px] font-semibold uppercase text-emerald-800/70 tracking-wider">Vendor</span>
                        <select
                          value={catVendor || ""}
                          onChange={(ev) => {
                            const v = ev.target.value;
                            if (v === "__add__") setShowAddVendor(cat.key);
                            else setCategoryVendor(cat.key, v);
                          }}
                          className="flex-1 h-7 text-xs bg-white border border-emerald-200 rounded px-1.5 text-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                          data-testid={`entry-cat-vendor-${cat.key}`}
                          title="Set the supplier for every item in this category on this day (rows explicitly overridden are left alone)"
                        >
                          <option value="">{mixed ? "— mixed (per-row overrides) —" : "— pick supplier —"}</option>
                          {vendors.map((v) => (
                            <option key={v.id} value={v.id}>{v.name}</option>
                          ))}
                          <option value="__add__">＋ Add new vendor…</option>
                        </select>
                        {mixed && (
                          <span className="text-[9px] font-bold uppercase tracking-wider text-amber-700 bg-amber-100 border border-amber-200 rounded px-1 py-0.5"
                                title="Items in this category use different suppliers today. Click a row to see or change its vendor.">
                            mixed
                          </span>
                        )}
                      </div>
                    </td>
                    <td colSpan={3} className="px-3 py-1.5 text-right">
                      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 leading-tight">Purch · Issue</div>
                      <div className="inline-flex items-center gap-2 text-xs font-extrabold tabular-nums leading-tight">
                        <span className="text-emerald-800" data-testid={`entry-cat-purch-total-${cat.key}`}>
                          {purchAmt > 0 ? `₹${inr(purchAmt)}` : <span className="text-emerald-700/40">—</span>}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="text-amber-800" data-testid={`entry-cat-issue-total-${cat.key}`}>
                          {issueAmt > 0 ? `₹${inr(issueAmt)}` : <span className="text-amber-700/40">—</span>}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {!isCollapsed && rows.map((it) => {
                    const e = purch[it.id] || {};
                    const purchAmt = num(e.qty) * num(e.rate);
                    const oh = stock[it.id];
                    const issueQty = issues[it.id];
                    const rate = avgRate[it.id] || 0;
                    const issueAmt = num(issueQty) * rate;
                    const over = oh != null && num(issueQty) > oh + 1e-6;
                    return (
                      <tr key={it.id} className={`border-t border-slate-100 hover:bg-slate-50/70 ${over ? "bg-rose-50/60" : ""}`} data-testid={`entry-row-${it.id}`}>
                        <td className="p-2">
                          <div className="font-semibold text-slate-900">{it.name}</div>
                          {/* Optional per-row vendor override — Aug 2026
                              user request. Category header sets the vendor
                              in bulk; this dropdown lets the chef point ONE
                              item at a different supplier on the same day. */}
                          <RowVendorPicker
                            rowVendorId={e.vendor_id || ""}
                            catVendorId={catVendor || ""}
                            vendors={vendors}
                            onChange={(v) => {
                              setPurchField(it.id, "vendor_id", v);
                              queuePurch();
                            }}
                            onAddNew={() => setShowAddVendor(cat.key)}
                            testid={`entry-row-vendor-${it.id}`}
                          />
                        </td>
                        <td className="p-2 text-slate-500 text-xs">{it.unit}</td>
                        <td className="p-2 text-right tabular-nums text-slate-600" data-testid={`entry-onhand-${it.id}`}>
                          {oh != null ? fmtQty(oh) : "—"}
                        </td>
                        <td className="p-2 border-l-2 border-emerald-100">
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
                        <td className="p-2 border-l-2 border-amber-100">
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
                        {/* Issue Rate — weighted-avg purchase cost, read-only. */}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showAddVendor && (
        <AddVendorInlineModal
          onClose={() => setShowAddVendor(null)}
          onCreated={(vendor) => {
            // Refresh master list, apply the new supplier to the
            // triggering category, close the modal.
            setVendors((prev) => [...prev, vendor].sort((a, b) => a.name.localeCompare(b.name)));
            setCategoryVendor(showAddVendor, vendor.id);
            setShowAddVendor(null);
            refreshVendors();
          }}
        />
      )}
    </div>
  );
}

// Small in-place vendor create dialog reachable from the "＋ Add new
// vendor…" option in the category-header dropdown on Daily entry.
// Keeps chefs on the pantry screen instead of context-switching to
// the Vendors master when a new supplier turns up mid-entry.
function AddVendorInlineModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      const v = await api.post("/meals/vendors", { name: n, phone: phone.trim() || null });
      toast.success(`Added ${v.name}`);
      onCreated(v);
    } catch (e) { showApiError(e); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" data-testid="add-vendor-inline-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-lg font-extrabold text-slate-900">Add new vendor</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" data-testid="add-vendor-close" title="Close"><X size={18}/></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-xs font-semibold text-slate-600">
            <div className="mb-1">Name</div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reliance Fresh"
              className="iu-input !h-10 !w-full text-sm"
              data-testid="add-vendor-name"
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            <div className="mb-1">Phone (optional)</div>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              className="iu-input !h-10 !w-full text-sm"
              data-testid="add-vendor-phone"
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button className="iu-btn-secondary !h-9" onClick={onClose} data-testid="add-vendor-cancel">Cancel</button>
          <button className="iu-btn-primary !h-9" onClick={submit} disabled={saving} data-testid="add-vendor-save">
            {saving ? "Saving…" : "Save vendor"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Date-wise drill-down modal (Aug 2026 user request).
// Opened by double-clicking either the Purchases or Issues totals card.
// Defaults to a 7-day window ending on the currently selected date;
// user can pick any start/end. `Print PDF` triggers window.print()
// against a purpose-styled #meal-totals-print-region so the rest of
// the app UI is stripped from the printout via @media print rules
// already living in index.css (print:hidden classes elsewhere).
// ---------------------------------------------------------------------
function DailyTotalsHistoryModal({ kind, selectedDate, onClose }) {
  // Sensible default: 7-day trailing window ending on the selected day.
  const [start, setStart] = useState(() => addDays(selectedDate, -6));
  const [end, setEnd] = useState(selectedDate);
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ grand_purchase_amt: 0, grand_issue_amt: 0 });
  const [loading, setLoading] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (start > end) return;
    setLoading(true);
    api.get("/meals/daily-totals", { start, end })
      .then((r) => {
        if (!alive) return;
        setRows(r.days || []);
        setTotals({
          grand_purchase_amt: r.grand_purchase_amt || 0,
          grand_issue_amt:    r.grand_issue_amt    || 0,
        });
      })
      .catch(showApiError)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [start, end]);

  const isPurch = kind === "purchase";
  const title = isPurch ? "Purchases · Date-wise totals" : "Issues · Date-wise totals";
  const accent = isPurch ? "emerald" : "amber";

  const doPrint = () => {
    // Apply the body-class-portal pattern used by the other Meals
    // print flows (see index.css). CSS hides every sibling except the
    // `#meal-totals-print-region` while this class is active.
    const cls = "meal-totals-print-active";
    document.body.classList.add(cls);
    setTimeout(() => {
      window.print();
      document.body.classList.remove(cls);
    }, 50);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 print:static print:bg-transparent print:p-0" data-testid="daily-totals-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col print:shadow-none print:rounded-none print:max-h-none print:w-full">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 print:hidden">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500">Double-clicked from the Daily entry card</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100"
            data-testid="daily-totals-modal-close"
            title="Close"
          ><X size={18}/></button>
        </div>

        <div className="px-5 py-3 flex items-end gap-3 flex-wrap border-b border-slate-100 print:hidden">
          <label className="text-xs font-semibold text-slate-600">
            <div className="mb-1 inline-flex items-center gap-1"><CalendarRange size={12}/> From</div>
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="iu-input !h-9 !w-auto text-sm"
              data-testid="daily-totals-start"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            <div className="mb-1">To</div>
            <input
              type="date"
              value={end}
              min={start}
              max={todayISO()}
              onChange={(e) => setEnd(e.target.value)}
              className="iu-input !h-9 !w-auto text-sm"
              data-testid="daily-totals-end"
            />
          </label>
          <div className="flex-1"/>
          <button
            type="button"
            onClick={doPrint}
            className="iu-btn-primary !h-9"
            data-testid="daily-totals-print-btn"
            title="Open the browser print dialog — pick 'Save as PDF' to download"
          ><Printer size={14}/> Print / Save PDF</button>
        </div>

        <div id="meal-totals-print-region" ref={printRef} className="flex-1 overflow-y-auto p-5 print:overflow-visible print:p-6">
          <div className="hidden print:block mb-4">
            <h1 className="text-2xl font-extrabold text-slate-900">{title}</h1>
            <p className="text-sm text-slate-600">
              {formatDate(start)} — {formatDate(end)}
            </p>
          </div>

          {loading ? (
            <div className="py-10 text-center text-slate-500 inline-flex items-center gap-2 w-full justify-center">
              <Loader2 size={16} className="animate-spin"/> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-slate-500" data-testid="daily-totals-empty">
              No purchases or issues recorded in this window.
            </div>
          ) : (
            <table className="w-full text-sm" data-testid="daily-totals-table">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="text-left p-2">Date</th>
                  <th className={`text-right p-2 ${isPurch ? "bg-emerald-50 text-emerald-800" : ""}`}>Purchases ₹</th>
                  <th className="text-right p-2 hidden sm:table-cell">Purch. lines</th>
                  <th className={`text-right p-2 ${!isPurch ? "bg-amber-50 text-amber-800" : ""}`}>Issues ₹</th>
                  <th className="text-right p-2 hidden sm:table-cell">Issue lines</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`daily-totals-row-${r.date}`}>
                    <td className="p-2 font-semibold text-slate-800 whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${isPurch ? "text-emerald-800" : "text-slate-700"}`}>
                      ₹{inr(r.purchase_amt)}
                    </td>
                    <td className="p-2 text-right text-slate-500 hidden sm:table-cell tabular-nums">{r.purchase_lines}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${!isPurch ? "text-amber-800" : "text-slate-700"}`}>
                      ₹{inr(r.issue_amt)}
                    </td>
                    <td className="p-2 text-right text-slate-500 hidden sm:table-cell tabular-nums">{r.issue_lines}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-100">
                  <td className="p-2 font-extrabold text-slate-900">Grand Total</td>
                  <td className={`p-2 text-right tabular-nums font-extrabold ${isPurch ? `text-${accent}-900` : "text-slate-900"}`} data-testid="daily-totals-grand-purch">
                    ₹{inr(totals.grand_purchase_amt)}
                  </td>
                  <td className="p-2 hidden sm:table-cell"/>
                  <td className={`p-2 text-right tabular-nums font-extrabold ${!isPurch ? `text-${accent}-900` : "text-slate-900"}`} data-testid="daily-totals-grand-issue">
                    ₹{inr(totals.grand_issue_amt)}
                  </td>
                  <td className="p-2 hidden sm:table-cell"/>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
