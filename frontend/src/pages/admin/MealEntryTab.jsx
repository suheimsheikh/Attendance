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
import { ChevronLeft, ChevronRight, ChevronDown, Loader2, Check, Boxes, Filter, Printer, X, CalendarRange, Search, StickyNote, Store, TrendingUp } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { useRowFocus } from "../../hooks/useRowFocus";
import VendorScorecardDrawer from "../../components/VendorScorecardDrawer";
import ItemPriceTrendDrawer from "../../components/ItemPriceTrendDrawer";

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
  n == null ? "0.00" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 1 });

/**
 * Per-row Supplier picker — visible column on the Daily-entry grid
 * (Feb 2026 user request: "modify to enter a supplier which carries
 * over for all items thereafter but with the facility to change the
 * supplier for a given item").
 *
 * Behaviour:
 *   • Every row shows a full inline <select> so the chef can pick or
 *     change the supplier without extra clicks or menus.
 *   • Whichever supplier is picked becomes the "sticky last-used"
 *     default that auto-fills the vendor of any BLANK row the chef
 *     touches next (existing rows are left alone).
 */
function RowVendorPicker({ rowVendorId, vendors, onChange, onAddNew, onArrowRight, onArrowUp, onArrowDown, onOpenScorecard, testid }) {
  const selected = vendors.find((v) => v.id === rowVendorId);
  return (
    <div className="flex items-center gap-1">
      <select
        value={rowVendorId || ""}
        onChange={(ev) => {
          const v = ev.target.value;
          if (v === "__add__") { onAddNew(); return; }
          onChange(v);
        }}
        onKeyDown={(ev) => {
          // Arrow keys navigate BETWEEN cells rather than cycling
          // options — matches the spreadsheet muscle memory the chefs
          // already have from the numeric cells. Space, click and
          // first-letter type still open the dropdown for picking.
          if (ev.key === "ArrowRight") { ev.preventDefault(); onArrowRight?.(); }
          else if (ev.key === "ArrowUp") { ev.preventDefault(); onArrowUp?.(); }
          else if (ev.key === "ArrowDown") { ev.preventDefault(); onArrowDown?.(); }
        }}
        className={`iu-input !h-8 !px-2 text-xs flex-1 min-w-0 text-slate-700 ${rowVendorId ? "font-semibold" : "text-slate-400"}`}
        data-testid={testid}
        title="Supplier for this item on this day. Click or press Space to pick; arrow keys move between cells."
      >
        <option value="">— pick supplier —</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
        <option value="__add__">＋ Add new vendor…</option>
      </select>
      {selected && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); onOpenScorecard(selected); }}
          title={`Vendor scorecard · ${selected.name}`}
          className="shrink-0 p-1 rounded text-emerald-600 hover:bg-emerald-100 transition"
          data-testid={`${testid}-scorecard-btn`}
        >
          <Store size={13}/>
        </button>
      )}
    </div>
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
  const [wastage, setWastage] = useState({});  // item_id → { qty, reason, notes }
  const [reasons, setReasons] = useState(["wasted","spoilt","rotten","lost","damaged","other"]);
  const [vendors, setVendors] = useState([]);  // {id, name, phone}[]
  const [showAddVendor, setShowAddVendor] = useState(null); // {catKey,itemId} on demand
  const [saving, setSaving] = useState({ purch: false, issues: false, wastage: false });
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
  // Row-focus tracking — shows a small "🟠 Priya is editing" chip on
  // any row a peer chef is currently in. Zero DB writes, ~100 B per
  // focus/blur.
  const { focusMap, notifyFocus, notifyBlur } = useRowFocus(dateStr, liveSig);
  // Sticky "last-used supplier" (Feb 2026 request). Whichever supplier
  // the chef picked most recently auto-fills the vendor of any BLANK
  // row they touch next — including the first row of the next day.
  // Persisted in localStorage so it survives reloads and day-nav.
  const [lastVendor, setLastVendor] = useState(() => {
    try { return localStorage.getItem("mealEntry.lastVendor") || ""; } catch { return ""; }
  });
  const persistLastVendor = (id) => {
    setLastVendor(id || "");
    try {
      if (id) localStorage.setItem("mealEntry.lastVendor", id);
      else localStorage.removeItem("mealEntry.lastVendor");
    } catch { /* storage blocked → not fatal */ }
  };
  // Sticky "last-used wastage reason" — mirrors the sticky supplier
  // logic. Auto-fills the reason on any BLANK wastage row the chef
  // enters a qty into; persisted so it survives reloads and day-nav.
  const [lastReason, setLastReason] = useState(() => {
    try { return localStorage.getItem("mealEntry.lastReason") || "wasted"; } catch { return "wasted"; }
  });
  const persistLastReason = (r) => {
    const clean = r || "wasted";
    setLastReason(clean);
    try { localStorage.setItem("mealEntry.lastReason", clean); } catch { /* not fatal */ }
  };
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
  // Vendor Scorecard + Item Price Trend drawers (Feb 2026). Cheap
  // read-only views wired to the same masters the grid already loads.
  const [scorecardVendorId, setScorecardVendorId] = useState(null);
  const [trendItem, setTrendItem] = useState(null);  // {id, name} or null

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

  const [catSortMode, setCatSortMode] = useState({}); // { [catKey]: 'consumption' | 'alpha' }
  // Snapshot of the "busiest" order at the moment the toggle was
  // clicked (per category). Rendering uses this frozen order so a row
  // the chef is typing into DOESN'T hop up or down on every keystroke.
  // Cleared whenever the toggle is flipped or the selected date changes.
  const [catSortSnapshot, setCatSortSnapshot] = useState({}); // { [catKey]: [id, id, …] }
  useEffect(() => { setCatSortSnapshot({}); }, [dateStr]);
  // Toggle is now purely LOCAL — reorders items ON SCREEN based on what
  // the chef has entered for THIS DATE (20 Feb 2026 clarification: the
  // toggle should reflect Daily Entry data, not the Masters sort order).
  // Nothing is written to the server; nothing else changes ordering
  // globally. Clicking flips the mode for that category only.
  const toggleCategorySort = (cat) => {
    const current = catSortMode[cat.key] || "consumption";
    const next = current === "consumption" ? "alpha" : "consumption";
    setCatSortMode((m) => ({ ...m, [cat.key]: next }));
    // Compute the fresh busiest snapshot NOW so subsequent keystrokes
    // don't shuffle rows underneath the chef. Only meaningful for
    // consumption mode — alpha ordering is stable regardless.
    if (next === "consumption") {
      const busy = (id) =>
        num(purch[id]?.qty) + num(issues[id]) + num(wastage[id]?.qty);
      const catItems = items
        .filter((it) => it.category_key === cat.key)
        .sort((a, b) => {
          const d = busy(b.id) - busy(a.id);
          return d !== 0 ? d : (a.sort_order ?? 0) - (b.sort_order ?? 0);
        })
        .map((it) => it.id);
      setCatSortSnapshot((s) => ({ ...s, [cat.key]: catItems }));
    } else {
      setCatSortSnapshot((s) => { const { [cat.key]: _drop, ...rest } = s; return rest; });
    }
    toast.success(
      next === "alpha"
        ? `${cat.label}: A → Z`
        : `${cat.label}: busiest first (today's purchases + issues)`
    );
  };

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
    const fresh = () => loadToken.current === token && dateRef.current === d;
    // Merge helper: server state wins EXCEPT for items with local unsaved
    // edits (dirty) — a refetch racing the user's typing must never
    // clobber what they just entered.
    const mergePurch = (next) => setPurch((prev) => {
      dirtyPurch.current.forEach((id) => { if (prev[id] !== undefined) next[id] = prev[id]; });
      return next;
    });
    const mergeIssues = (next) => setIssues((prev) => {
      dirtyIssues.current.forEach((id) => { if (prev[id] !== undefined) next[id] = prev[id]; });
      return next;
    });
    const mergeWastage = (next) => setWastage((prev) => {
      dirtyWastage.current.forEach((id) => { if (prev[id] !== undefined) next[id] = prev[id]; });
      return next;
    });
    api.get(`/meals/purchases?start=${d}&end=${d}`)
      .then((r) => {
        if (!fresh()) return;
        const lines = r.purchases?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = { qty: l.qty, rate: l.rate != null && l.rate !== "" ? Number(l.rate).toFixed(2) : l.rate, vendor_id: l.vendor_id || "" }; });
        mergePurch(next);
      })
      .catch(() => { if (fresh()) mergePurch({}); });

    api.get(`/meals/issues?start=${d}&end=${d}`)
      .then((r) => {
        if (!fresh()) return;
        const lines = r.issues?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = l.qty; });
        mergeIssues(next);
      })
      .catch(() => { if (fresh()) mergeIssues({}); });

    api.get(`/meals/wastage?start=${d}&end=${d}`)
      .then((r) => {
        if (!fresh()) return;
        if (r.reasons?.length) setReasons(r.reasons);
        const lines = r.wastage?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = { qty: l.qty, reason: l.reason || "wasted", notes: l.notes || "" }; });
        mergeWastage(next);
      })
      .catch(() => { if (fresh()) mergeWastage({}); });

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
      if (wastageTimer.current) { clearTimeout(wastageTimer.current); wastageTimer.current = null; flushWastage(dateStr); }
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
      const busy = savingRef.current.purch || savingRef.current.issues || savingRef.current.wastage ||
        purchTimer.current || issuesTimer.current || wastageTimer.current ||
        pendingSave.current.purch || pendingSave.current.issues || pendingSave.current.wastage;
      // Note: a merely-focused cell no longer blocks the refetch —
      // loadDay's dirty merge-preserve already protects unsaved typing.
      if (busy) { setTimeout(attempt, 2000); return; }
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
  const wastageTimer = useRef(null);
  const latestPurch = useRef(purch);
  const latestIssues = useRef(issues);
  const latestWastage = useRef(wastage);
  useEffect(() => { latestPurch.current = purch; }, [purch]);
  useEffect(() => { latestIssues.current = issues; }, [issues]);
  useEffect(() => { latestWastage.current = wastage; }, [wastage]);

  // Serialised save chains — a new save NEVER interrupts one already in
  // flight (user request, Aug 2026). Each flush snapshots its payload
  // synchronously (so it belongs to the right day) and then queues the
  // network PUT behind whatever save is currently running, guaranteeing
  // in-order arrival at the server. Consecutive queued saves for the
  // same date coalesce to the latest snapshot.
  const saveChain = useRef({ purch: Promise.resolve(), issues: Promise.resolve(), wastage: Promise.resolve() });
  const pendingSave = useRef({ purch: null, issues: null, wastage: null }); // seq de-dupe
  const saveSeq = useRef({ purch: 0, issues: 0, wastage: 0 });
  // Dirty tracking (Jun 2026 multi-machine fix): each save sends ONLY the
  // item lines THIS machine edited (PATCH merge on the server) so two
  // machines entering different items on the same day never wipe each
  // other's rows — the old whole-table PUT was last-writer-wins.
  const dirtyPurch = useRef(new Set());
  const dirtyIssues = useRef(new Set());
  const dirtyWastage = useRef(new Set());

  // Both flushes take the TARGET date explicitly (captured at queue time)
  // so the PATCH URL always matches the day the lines belong to, even if
  // the user has since navigated to another day.
  const flushPurchases = (targetDate) => {
    // Snapshot NOW — refs still hold this day's values at call time.
    const ids = Array.from(dirtyPurch.current);
    dirtyPurch.current = new Set();
    // Merge ids from an unsent pending snapshot for the same date (it
    // will be skipped in favour of this one).
    const prev = pendingSave.current.purch;
    if (prev && prev.targetDate === targetDate) {
      prev.ids.forEach((i) => { if (!ids.includes(i)) ids.push(i); });
    }
    if (!ids.length) return saveChain.current.purch;
    const upserts = [];
    const removes = [];
    ids.forEach((iid) => {
      const e = latestPurch.current[iid];
      const qty = num(e?.qty);
      const rate = num(e?.rate);
      if (qty <= 0 && rate <= 0) removes.push(iid);
      else upserts.push({ item_id: iid, qty, rate, vendor_id: e?.vendor_id || null });
    });
    const seq = ++saveSeq.current.purch;
    pendingSave.current.purch = { seq, targetDate, ids, upserts, removes };
    const run = async () => {
      const p = pendingSave.current.purch;
      // A newer snapshot for the SAME date superseded this one (our ids
      // were merged into it) — skip; the newer queued run sends them.
      if (!p || (p.seq !== seq && p.targetDate === targetDate)) return;
      const mine = p.seq === seq;
      const payload = mine ? p : { targetDate, ids, upserts, removes };
      if (mine) pendingSave.current.purch = null;
      setSaving((s) => ({ ...s, purch: true }));
      try {
        await api.patch(`/meals/purchases/${payload.targetDate}`,
          { upserts: payload.upserts, removes: payload.removes });
        setSavedAt(Date.now());
        // Purchases just changed → weighted-avg rate changed → issue
        // amounts on the currently displayed day must update.
        refreshAvgRate(dateRef.current);
      } catch (err) {
        // Re-mark failed ids so the next edit / flush retries them.
        payload.ids.forEach((i) => dirtyPurch.current.add(i));
        showApiError(err, "Couldn't auto-save purchases");
      } finally {
        setSaving((s) => ({ ...s, purch: false }));
      }
    };
    saveChain.current.purch = saveChain.current.purch.then(run, run);
    return saveChain.current.purch;
  };
  const flushIssues = (targetDate) => {
    const ids = Array.from(dirtyIssues.current);
    dirtyIssues.current = new Set();
    const prev = pendingSave.current.issues;
    if (prev && prev.targetDate === targetDate) {
      prev.ids.forEach((i) => { if (!ids.includes(i)) ids.push(i); });
    }
    if (!ids.length) return saveChain.current.issues;
    const upserts = [];
    const removes = [];
    ids.forEach((iid) => {
      const qty = num(latestIssues.current[iid]);
      if (qty > 0) upserts.push({ item_id: iid, qty });
      else removes.push(iid);
    });
    const seq = ++saveSeq.current.issues;
    pendingSave.current.issues = { seq, targetDate, ids, upserts, removes };
    const run = async () => {
      const p = pendingSave.current.issues;
      if (!p || (p.seq !== seq && p.targetDate === targetDate)) return;
      const mine = p.seq === seq;
      const payload = mine ? p : { targetDate, ids, upserts, removes };
      if (mine) pendingSave.current.issues = null;
      setSaving((s) => ({ ...s, issues: true }));
      try {
        await api.patch(`/meals/issues/${payload.targetDate}`,
          { upserts: payload.upserts, removes: payload.removes });
        setSavedAt(Date.now());
      } catch (err) {
        payload.ids.forEach((i) => dirtyIssues.current.add(i));
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
  const flushWastage = (targetDate) => {
    const ids = Array.from(dirtyWastage.current);
    dirtyWastage.current = new Set();
    const prev = pendingSave.current.wastage;
    if (prev && prev.targetDate === targetDate) {
      prev.ids.forEach((i) => { if (!ids.includes(i)) ids.push(i); });
    }
    if (!ids.length) return saveChain.current.wastage;
    const upserts = [];
    const removes = [];
    ids.forEach((iid) => {
      const w = latestWastage.current[iid];
      const qty = num(w?.qty);
      const notes = (w?.notes || "").trim();
      // Persist any row that has either a positive qty OR a non-empty
      // note. Notes-without-qty is a legitimate case ("check tomorrow"
      // scribble before the chef weighs the loss) — dropping it silently
      // was the Feb 2026 code-review Medium finding.
      if (qty > 0 || notes) {
        upserts.push({ item_id: iid, qty, reason: w?.reason || "wasted", notes });
      } else {
        removes.push(iid);
      }
    });
    const seq = ++saveSeq.current.wastage;
    pendingSave.current.wastage = { seq, targetDate, ids, upserts, removes };
    const run = async () => {
      const p = pendingSave.current.wastage;
      if (!p || (p.seq !== seq && p.targetDate === targetDate)) return;
      const mine = p.seq === seq;
      const payload = mine ? p : { targetDate, ids, upserts, removes };
      if (mine) pendingSave.current.wastage = null;
      setSaving((s) => ({ ...s, wastage: true }));
      try {
        await api.patch(`/meals/wastage/${payload.targetDate}`,
          { upserts: payload.upserts, removes: payload.removes });
        setSavedAt(Date.now());
      } catch (err) {
        payload.ids.forEach((i) => dirtyWastage.current.add(i));
        showApiError(err, "Couldn't auto-save wastage");
      } finally {
        setSaving((s) => ({ ...s, wastage: false }));
      }
    };
    saveChain.current.wastage = saveChain.current.wastage.then(run, run);
    return saveChain.current.wastage;
  };
  const queueWastage = () => {
    clearTimeout(wastageTimer.current);
    const d = dateStr;
    wastageTimer.current = setTimeout(() => { wastageTimer.current = null; flushWastage(d); }, 350);
  };

  const setPurchField = (itemId, field, value) => {
    dirtyPurch.current.add(itemId);
    setPurch((prev) => {
      const existing = prev[itemId] || {};
      const updated = { ...existing, [field]: value };
      // Sticky-vendor auto-fill (Feb 2026): when the chef starts entering
      // qty/rate on a row that has NO supplier yet, quietly stamp the
      // last-used supplier so most rows get their vendor set without an
      // extra click. Rows that already have a vendor are left untouched.
      if ((field === "qty" || field === "rate") && !existing.vendor_id && lastVendor) {
        updated.vendor_id = lastVendor;
      }
      return { ...prev, [itemId]: updated };
    });
  };

  // Explicit per-row supplier change. Sets the sticky "last-used"
  // default (so the NEXT blank row auto-fills with this vendor) but
  // never touches any other row — only new/edited rows use the new
  // supplier; already-entered rows keep their existing vendor.
  const setRowVendor = (itemId, vendorId) => {
    dirtyPurch.current.add(itemId);
    setPurch((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), vendor_id: vendorId } }));
    persistLastVendor(vendorId);
    queuePurch();
  };

  // Wastage row edits — mirror the purchases sticky-vendor pattern. If
  // the chef types qty on a row that has no reason yet, quietly stamp
  // the last-used reason so most rows get their reason set without an
  // extra click. Existing reason is left untouched.
  const setWastageField = (itemId, field, value) => {
    dirtyWastage.current.add(itemId);
    setWastage((prev) => {
      const existing = prev[itemId] || {};
      const updated = { ...existing, [field]: value };
      if (field === "qty" && !existing.reason && lastReason) {
        updated.reason = lastReason;
      }
      return { ...prev, [itemId]: updated };
    });
  };
  const setRowReason = (itemId, reason) => {
    dirtyWastage.current.add(itemId);
    setWastage((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), reason } }));
    persistLastReason(reason);
    queueWastage();
  };
  const setWastageNotes = (itemId, notes) => {
    dirtyWastage.current.add(itemId);
    setWastage((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), notes } }));
    queueWastage();
  };
  // Which row's notes popover is currently open (null = none). Only one
  // is visible at a time to avoid the grid getting noisy.
  const [notesEditor, setNotesEditor] = useState(null);

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
  const isTouched = (it) => num(purch[it.id]?.qty) > 0 || num(purch[it.id]?.rate) > 0 || num(issues[it.id]) > 0 || num(wastage[it.id]?.qty) > 0;
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
      // Sum Purch, Issue and Wastage amounts for the category header
      // chips. Wastage merged into the entry grid Feb 2026.
      let pAmt = 0, iAmt = 0, wAmt = 0;
      let pQty = 0, iQty = 0, wQty = 0;
      for (const it of rows) {
        const e = purch[it.id] || {};
        pAmt += num(e.qty) * num(e.rate);
        pQty += num(e.qty);
        const rate = avgRate[it.id] || 0;
        iAmt += num(issues[it.id]) * rate;
        iQty += num(issues[it.id]);
        wAmt += num(wastage[it.id]?.qty) * rate;
        wQty += num(wastage[it.id]?.qty);
      }
      // Feb 2026: apply the toggle's LOCAL sort mode. "consumption" =
      // busiest first based on TODAY's entered data (purch qty + issue
      // qty + wastage qty). Items with no activity today keep their
      // master order at the bottom. "alpha" = A → Z. Nothing is
      // persisted — pure view-level reorder so the chef can flip the
      // list to whichever grouping helps them for THIS day.
      const mode = catSortMode[cat.key] || "consumption";
      const sortedRows = rows.slice();
      if (mode === "alpha") {
        sortedRows.sort((a, b) =>
          (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
      } else if (mode === "consumption") {
        const snap = catSortSnapshot[cat.key];
        if (snap && snap.length) {
          // FROZEN order — captured when toggle was clicked. Rows the
          // chef is typing into stay put; new items (added after the
          // snapshot) fall to the end so nothing disappears.
          const idx = new Map(snap.map((id, i) => [id, i]));
          sortedRows.sort(
            (a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9)
          );
        } else {
          const busy = (it) =>
            num(purch[it.id]?.qty) + num(issues[it.id]) + num(wastage[it.id]?.qty);
          sortedRows.sort((a, b) => {
            const d = busy(b) - busy(a);
            // Tie-break by master sort_order (preserves the walk-through
            // sequence you set up in Stock Master).
            return d !== 0 ? d : (a.sort_order ?? 0) - (b.sort_order ?? 0);
          });
        }
      }
      return { cat, rows: sortedRows, purchAmt: pAmt, issueAmt: iAmt, wastageAmt: wAmt, purchQty: pQty, issueQty: iQty, wastageQty: wQty };
    });
  }, [grouped, nonZeroOnly, purch, issues, wastage, avgRate, search, catSortMode, catSortSnapshot]);

  // Flat list of currently-VISIBLE item ids in the exact order they
  // appear in the grid (respects category collapse + filters). Used by
  // the keyboard-navigation handler below so ArrowUp/Down jumps to the
  // next row the eye can actually see, skipping collapsed categories.
  const flatVisibleItemIds = useMemo(() => {
    const out = [];
    for (const { cat, rows } of filteredGrouped) {
      if (collapsedCats.has(cat.key)) continue;
      for (const it of rows) out.push(it.id);
    }
    return out;
  }, [filteredGrouped, collapsedCats]);

  // Keyboard grid navigation (Feb 2026 user request). Arrow keys move
  // between cells INSTEAD of nudging the number spinner; Enter after
  // Rate jumps to the next row's Qty so a chef can rattle through a
  // supplier's bill without touching the mouse.
  //   Column order across a row: purch-qty → purch-rate → issue-qty.
  //   Enter        purch-qty  → purch-rate         (same row)
  //   Enter        purch-rate → next row purch-qty
  //   Enter        issue-qty  → next row issue-qty
  //   Arrow keys always move between cells; number step is suppressed.
  const gridCols = ["purch-qty", "purch-rate", "issue-qty", "wastage-qty"];
  const focusCell = (kind, itemId) => {
    const el = document.querySelector(`[data-testid="entry-${kind}-${itemId}"]`);
    if (el) { el.focus(); if (el.select) el.select(); }
  };
  // Focus one of the two per-row picker selects (Supplier / Reason).
  // Kept separate from focusCell because select elements don't take a
  // .select() text range and their data-testid pattern differs.
  const focusPicker = (kind, itemId) => {
    const el = document.querySelector(`[data-testid="entry-${kind}-${itemId}"]`);
    if (el) el.focus();
  };
  const onGridKeyDown = (kind, itemId) => (ev) => {
    const idx = flatVisibleItemIds.indexOf(itemId);
    if (idx < 0) return;
    const colIdx = gridCols.indexOf(kind);
    const key = ev.key;
    if (key === "ArrowUp") {
      ev.preventDefault();
      const prev = flatVisibleItemIds[idx - 1];
      if (prev) focusCell(kind, prev);
    } else if (key === "ArrowDown") {
      ev.preventDefault();
      const next = flatVisibleItemIds[idx + 1];
      if (next) focusCell(kind, next);
    } else if (key === "ArrowLeft") {
      ev.preventDefault();
      if (colIdx > 0) focusCell(gridCols[colIdx - 1], itemId);
      else if (kind === "purch-qty") {
        // Step further left into the row's Supplier picker so the whole
        // Purchases half is keyboard-walkable end to end.
        const sel = document.querySelector(`[data-testid="entry-row-vendor-${itemId}"]`);
        if (sel) sel.focus();
      }
    } else if (key === "ArrowRight") {
      ev.preventDefault();
      if (colIdx < gridCols.length - 1) focusCell(gridCols[colIdx + 1], itemId);
      else if (kind === "wastage-qty") {
        // Step further right into the row's Reason picker so the
        // Wastage half is keyboard-walkable end to end.
        const sel = document.querySelector(`[data-testid="entry-wastage-reason-${itemId}"]`);
        if (sel) sel.focus();
      }
    } else if (key === "Enter") {
      ev.preventDefault();
      if (kind === "purch-qty") {
        focusCell("purch-rate", itemId);
      } else if (kind === "purch-rate") {
        const next = flatVisibleItemIds[idx + 1];
        if (next) focusCell("purch-qty", next);
      } else if (kind === "issue-qty") {
        const next = flatVisibleItemIds[idx + 1];
        if (next) focusCell("issue-qty", next);
      } else if (kind === "wastage-qty") {
        const next = flatVisibleItemIds[idx + 1];
        if (next) focusCell("wastage-qty", next);
      }
    }
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

  // Day-wide wastage value = Σ (wasted_qty × item's weighted-avg cost).
  const wastageDayTotal = useMemo(() => {
    let s = 0;
    for (const it of items) {
      s += num(wastage[it.id]?.qty) * (avgRate[it.id] || 0);
    }
    return s;
  }, [items, wastage, avgRate]);

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
            {(saving.purch || saving.issues || saving.wastage) ? (
              <span className="text-slate-500 inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin"/> Saving…</span>
            ) : savedAt && (Date.now() - savedAt) < 3000 ? (
              <span className="text-emerald-600 inline-flex items-center gap-1"><Check size={12}/> Saved</span>
            ) : (
              <span className="text-slate-400">Auto-saves as you type</span>
            )}
          </span>
        </div>

        {/* Day totals — laid out as a mini-table that shares the SAME
            column widths as the grid below, so each amount sits
            directly above its column's item Amounts. Labels tuck to
            the left of each band, numbers hang on the right rail. */}
        <table className="w-full text-sm" data-testid="entry-totals-bar">
          <colgroup>
            <col className="w-[14%]"/>
            <col className="w-10"/>
            <col className="w-14"/>
            <col className="w-36"/>
            <col className="w-20"/>
            <col className="w-24"/>
            <col className="w-28"/>
            <col className="w-20"/>
            <col className="w-24"/>
            <col className="w-28"/>
            <col className="w-20"/>
            <col className="w-28"/>
            <col className="w-28"/>
          </colgroup>
          <tbody>
            <tr>
              <td colSpan={3}/>
              <td colSpan={3}
                className="px-2 py-2 border border-emerald-200 bg-emerald-50/60 rounded-l-lg border-r-0 cursor-pointer hover:bg-emerald-50 select-none"
                onDoubleClick={() => setHistoryKind("purchase")}
                title="Double-click to see date-wise purchase totals and download a PDF">
                <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-700">
                  Purchases · Day total
                  <span className="ml-1 text-[9px] font-normal text-emerald-600/80 normal-case tracking-normal">(dbl-click for history)</span>
                </span>
              </td>
              <td className="px-3 py-2 text-right border border-emerald-200 bg-emerald-50/60 rounded-r-lg border-l-0 cursor-pointer hover:bg-emerald-50 select-none"
                  onDoubleClick={() => setHistoryKind("purchase")}
                  data-testid="entry-purchase-total-card">
                <span className="text-lg font-extrabold tabular-nums text-emerald-800" data-testid="entry-day-total">₹{inr(dayTotal)}</span>
              </td>
              <td colSpan={2}
                className="px-2 py-2 border border-amber-200 bg-amber-50/60 rounded-l-lg border-r-0 ml-2 cursor-pointer hover:bg-amber-50 select-none"
                onDoubleClick={() => setHistoryKind("issue")}
                title="Double-click to see date-wise issues totals and download a PDF">
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
                  Issues · Day total
                  <span className="ml-1 text-[9px] font-normal text-amber-600/80 normal-case tracking-normal">(dbl-click for history)</span>
                </span>
              </td>
              <td className="px-3 py-2 text-right border border-amber-200 bg-amber-50/60 rounded-r-lg border-l-0 cursor-pointer hover:bg-amber-50 select-none"
                  onDoubleClick={() => setHistoryKind("issue")}
                  data-testid="entry-issue-total-card">
                <span className="text-lg font-extrabold tabular-nums text-amber-800" data-testid="entry-day-issue-total">₹{inr(issueDayTotal)}</span>
              </td>
              <td colSpan={2}
                className="px-2 py-2 border border-rose-200 bg-rose-50/60 rounded-l-lg border-r-0"
                title="Total stock value lost to wastage today (at weighted-avg cost)">
                <span className="text-[11px] font-bold uppercase tracking-wider text-rose-700">Wastage · Day total</span>
              </td>
              <td className="px-3 py-2 text-right border border-rose-200 bg-rose-50/60 rounded-r-lg border-l-0" data-testid="entry-wastage-total-card">
                <span className="text-lg font-extrabold tabular-nums text-rose-800" data-testid="entry-day-wastage-total">₹{inr(wastageDayTotal)}</span>
              </td>
            </tr>
          </tbody>
        </table>
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
                <th colSpan={4} className="bg-emerald-600 text-white text-[11px] font-extrabold uppercase tracking-wider px-3 py-1.5 border-b border-emerald-700 text-left">
                  ↓ Purchases
                </th>
                <th colSpan={3} className="bg-amber-500 text-white text-[11px] font-extrabold uppercase tracking-wider px-3 py-1.5 border-b border-amber-600 text-left">
                  ↓ Issues
                </th>
                <th colSpan={3} className="bg-rose-600 text-white text-[11px] font-extrabold uppercase tracking-wider px-3 py-1.5 border-b border-rose-700 text-left">
                  ↓ Wastage
                </th>
              </tr>
              <tr className="bg-slate-50 text-[11px] uppercase font-bold text-slate-700">
                <th className="text-left p-2 w-[14%]">Item</th>
                <th className="text-left px-1 py-2 w-10">Unit</th>
                <th className="text-right px-1 py-2 w-14" title="Stock on hand at end of previous day">On-hand</th>
                <th className="text-left p-2 w-36 border-l-2 border-emerald-500 bg-emerald-50/70" title="Supplier for this item on this day">Supplier</th>
                <th className="text-right p-2 w-20 bg-emerald-50/70">Qty</th>
                <th className="text-right p-2 w-24 bg-emerald-50/70">Rate ₹</th>
                <th className="text-right p-2 w-28 bg-emerald-50/70">Amount ₹</th>
                <th className="text-right p-2 w-20 border-l-2 border-amber-500 bg-amber-50/70">Qty</th>
                <th className="text-right p-2 w-24 bg-amber-50/70" title="Weighted-average purchase cost — auto-calculated, not editable">Rate ₹</th>
                <th className="text-right p-2 w-28 bg-amber-50/70">Amount ₹</th>
                <th className="text-right p-2 w-20 border-l-2 border-rose-500 bg-rose-50/70">Qty</th>
                <th className="text-left p-2 w-28 bg-rose-50/70" title="Why the stock was lost — pick from the master list">Reason</th>
                <th className="text-right p-2 w-28 bg-rose-50/70" title="Wastage value at weighted-average cost">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {filteredGrouped.map(({ cat, rows, purchAmt, issueAmt, wastageAmt, purchQty, issueQty, wastageQty }) => {
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
                    <td colSpan={1} className="px-2 py-1.5 text-right border-l-2 border-emerald-500 bg-amber-100">
                      {!isCollapsed && rows.length > 1 && (
                        (() => {
                          const mode = catSortMode[cat.key] || "consumption";
                          const isAlpha = mode === "alpha";
                          return (
                            <button
                              type="button"
                              onClick={(ev) => { ev.stopPropagation(); toggleCategorySort(cat); }}
                              className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-[10px] font-bold uppercase tracking-wider text-amber-900 bg-amber-200/70 hover:bg-amber-300 border border-amber-400/60 transition"
                              title={isAlpha
                                ? "Currently A → Z. Click to switch to busiest-first (by today's purchase / issue / wastage qty)."
                                : "Currently busiest-first based on TODAY'S entered qty. Click to switch to A → Z. This is a view-only sort — the Master order is not changed."}
                              data-testid={`entry-cat-sort-toggle-${cat.key}`}
                            >
                              {isAlpha
                                ? <><span className="font-black">A→Z</span></>
                                : <><TrendingUp size={11}/> Busiest first</>}
                            </button>
                          );
                        })()
                      )}
                    </td>
                    {/* Purch qty subtotal — aligned under the Purchases Qty col. */}
                    <td className="p-2 text-right font-semibold tabular-nums text-emerald-800/80 text-xs" data-testid={`entry-cat-purch-qty-${cat.key}`}>
                      {purchQty > 0 ? fmtQty(purchQty) : ""}
                    </td>
                    {/* Spacer over Purch Rate. */}
                    <td/>
                    {/* Purch amount subtotal — same typography as the item-row
                        Amount cells so the eye reads the column as one
                        continuous currency stream. */}
                    <td className="p-2 text-right font-semibold tabular-nums text-emerald-700" data-testid={`entry-cat-purch-total-${cat.key}`}>
                      {purchAmt > 0 ? `₹${inr(purchAmt)}` : <span className="text-emerald-700/40">—</span>}
                    </td>
                    {/* Issue qty subtotal under Issues Qty col. */}
                    <td className="p-2 text-right font-semibold tabular-nums text-amber-800/80 text-xs border-l-2 border-amber-500" data-testid={`entry-cat-issue-qty-${cat.key}`}>
                      {issueQty > 0 ? fmtQty(issueQty) : ""}
                    </td>
                    {/* Spacer over Issues Rate. */}
                    <td/>
                    <td className="p-2 text-right font-semibold tabular-nums text-amber-700" data-testid={`entry-cat-issue-total-${cat.key}`}>
                      {issueAmt > 0 ? `₹${inr(issueAmt)}` : <span className="text-amber-700/40">—</span>}
                    </td>
                    {/* Wastage qty subtotal under Wastage Qty col. */}
                    <td className="p-2 text-right font-semibold tabular-nums text-rose-800/80 text-xs border-l-2 border-rose-500" data-testid={`entry-cat-wastage-qty-${cat.key}`}>
                      {wastageQty > 0 ? fmtQty(wastageQty) : ""}
                    </td>
                    {/* Spacer over Wastage Reason. */}
                    <td/>
                    <td className="p-2 text-right font-semibold tabular-nums text-rose-700" data-testid={`entry-cat-wastage-total-${cat.key}`}>
                      {wastageAmt > 0 ? `₹${inr(wastageAmt)}` : <span className="text-rose-700/40">—</span>}
                    </td>
                  </tr>
                  {!isCollapsed && rows.map((it) => {
                    const e = purch[it.id] || {};
                    const purchAmt = num(e.qty) * num(e.rate);
                    const oh = stock[it.id];
                    const issueQty = issues[it.id];
                    const rate = avgRate[it.id] || 0;
                    const issueAmt = num(issueQty) * rate;
                    const w = wastage[it.id] || {};
                    const wasteAmt = num(w.qty) * rate;
                    // Overshoot on issues + wastage combined (both deplete stock).
                    const over = oh != null && (num(issueQty) + num(w.qty)) > oh + 1e-6;
                    // Peer-editing chip — if another chef is focused on
                    // ANY editable cell of this row right now, show a
                    // small badge with their name.
                    const peer =
                      focusMap.get(`purch:${it.id}`) ||
                      focusMap.get(`issue:${it.id}`) ||
                      focusMap.get(`wastage:${it.id}`) ||
                      null;
                    return (
                      <tr key={it.id} className={`border-t border-slate-100 hover:bg-slate-50/70 ${over ? "bg-rose-50/60" : peer ? "bg-sky-50/40" : ""}`} data-testid={`entry-row-${it.id}`}>
                        <td
                          className="p-2 cursor-pointer select-none"
                          onDoubleClick={() => setTrendItem({ id: it.id, name: it.name })}
                          title="Double-click to see full price history for this item"
                          data-testid={`entry-item-name-${it.id}`}
                        >
                          <div className="font-semibold text-slate-900 flex items-center gap-1.5 hover:text-sky-700">
                            <span>{it.name}</span>
                            {peer && (
                              <span
                                className="text-[9px] font-bold uppercase tracking-wider text-sky-700 bg-sky-100 border border-sky-200 rounded px-1 py-0.5"
                                title={`${peer.name} is editing this row now — the value may change under you`}
                                data-testid={`entry-row-peer-${it.id}`}
                              >
                                ✎ {peer.name.split(" ")[0]}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-1 py-2 text-slate-500 text-xs">{it.unit}</td>
                        <td className="px-1 py-2 text-right tabular-nums text-slate-600" data-testid={`entry-onhand-${it.id}`}>
                          {oh != null ? (
                            oh < 0
                              ? <span
                                  className="font-extrabold text-rose-700"
                                  title={`Stock is negative (${fmtQty(oh)}) — likely from over-issuing on a past day. Reconcile before fresh issues.`}
                                  data-testid={`entry-onhand-negative-${it.id}`}
                                >{fmtQty(oh)}</span>
                              : oh === 0
                                ? <span className="font-semibold text-rose-500" title="Zero stock — nothing to issue">{fmtQty(oh)}</span>
                                : fmtQty(oh)
                          ) : "—"}
                        </td>
                        <td className="p-2 border-l-2 border-emerald-100">
                          {/* Per-row Supplier column — visible dropdown so
                              the chef can set or change the vendor for
                              this one item. Picking here also updates the
                              sticky "last-used" default that auto-fills
                              the next blank row the chef touches. */}
                          <RowVendorPicker
                            rowVendorId={e.vendor_id || ""}
                            vendors={vendors}
                            onChange={(v) => setRowVendor(it.id, v)}
                            onAddNew={() => setShowAddVendor({ catKey: cat.key, itemId: it.id })}
                            onOpenScorecard={(v) => setScorecardVendorId(v.id)}
                            onArrowRight={() => focusCell("purch-qty", it.id)}
                            onArrowUp={() => {
                              const idx = flatVisibleItemIds.indexOf(it.id);
                              const prev = flatVisibleItemIds[idx - 1];
                              if (prev) focusPicker("row-vendor", prev);
                            }}
                            onArrowDown={() => {
                              const idx = flatVisibleItemIds.indexOf(it.id);
                              const next = flatVisibleItemIds[idx + 1];
                              if (next) focusPicker("row-vendor", next);
                            }}
                            testid={`entry-row-vendor-${it.id}`}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number" min="0" step="0.01"
                            value={e.qty ?? ""}
                            onChange={(ev) => setPurchField(it.id, "qty", ev.target.value)}
                            onFocus={() => notifyFocus("purch", it.id)}
                            onBlur={() => { notifyBlur("purch", it.id); queuePurch(); }}
                            onKeyDown={onGridKeyDown("purch-qty", it.id)}
                            className="iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums"
                            placeholder="0"
                            data-testid={`entry-purch-qty-${it.id}`}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number" min="0" step="0.01"
                            value={e.rate ?? ""}
                            onChange={(ev) => setPurchField(it.id, "rate", ev.target.value)}
                            onFocus={() => notifyFocus("purch", it.id)}
                            onBlur={() => {
                              // Snap the typed rate to a fixed 2-decimal
                              // string on blur so the column reads as
                              // proper currency (e.g. "50" → "50.00",
                              // "60.5" → "60.50"). Empty stays empty.
                              const raw = latestPurch.current[it.id]?.rate;
                              if (raw !== undefined && raw !== "" && !isNaN(Number(raw))) {
                                const fixed = Number(raw).toFixed(2);
                                if (fixed !== String(raw)) setPurchField(it.id, "rate", fixed);
                              }
                              notifyBlur("purch", it.id);
                              queuePurch();
                            }}
                            onKeyDown={onGridKeyDown("purch-rate", it.id)}
                            className="iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums"
                            placeholder="0.00"
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
                            onChange={(ev) => { dirtyIssues.current.add(it.id); setIssues({ ...issues, [it.id]: ev.target.value }); }}
                            onFocus={() => notifyFocus("issue", it.id)}
                            onBlur={() => {
                              notifyBlur("issue", it.id);
                              // Hard toast warning at commit time — cheap
                              // fat-finger guard: if the entered issue by
                              // itself already exceeds on-hand stock, tell
                              // the chef before the queued save fires so
                              // they can back out. Kept as a toast (not a
                              // block) because a rare emergency issue on
                              // negative stock is still legal — the entry
                              // just needs a same-day purchase to
                              // reconcile.
                              const q = num(issueQty);
                              if (oh != null && q > oh + 1e-6) {
                                toast.warning(
                                  `Issuing ${fmtQty(q)} ${it.unit} of ${it.name} — only ${fmtQty(oh)} on hand. Stock will drop to ${fmtQty(oh - q)}.`,
                                  { duration: 6000 },
                                );
                              }
                              queueIssues();
                            }}
                            onKeyDown={onGridKeyDown("issue-qty", it.id)}
                            className={`iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`}
                            placeholder="0"
                            data-testid={`entry-issue-qty-${it.id}`}
                            title={over ? "Issues exceed on-hand — will drive stock negative" : ""}
                          />
                        </td>
                        {/* Issue Rate — weighted-avg purchase cost, read-only. */}
                        <td className="p-2 text-right tabular-nums text-slate-500 text-xs" data-testid={`entry-issue-rate-${it.id}`} title="Weighted-average purchase cost across all recorded purchases">
                          {rate > 0 ? `₹${inr(rate)}` : "—"}
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums text-amber-700" data-testid={`entry-issue-amt-${it.id}`}>
                          {issueAmt > 0 ? `₹${inr(issueAmt)}` : ""}
                        </td>
                        {/* Wastage half — Qty + Reason + Amount. Both
                            Issues and Wastage deplete stock, so the
                            "over" warning fires on the combined total. */}
                        <td className="p-2 border-l-2 border-rose-100">
                          <input
                            type="number" min="0" step="0.01"
                            value={w.qty ?? ""}
                            onChange={(ev) => setWastageField(it.id, "qty", ev.target.value)}
                            onFocus={() => notifyFocus("wastage", it.id)}
                            onBlur={() => { notifyBlur("wastage", it.id); queueWastage(); }}
                            onKeyDown={onGridKeyDown("wastage-qty", it.id)}
                            className={`iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`}
                            placeholder="0"
                            data-testid={`entry-wastage-qty-${it.id}`}
                            title={over ? "Issues + Wastage exceed on-hand — will drive stock negative" : "Quantity lost to wastage / spoilage"}
                          />
                        </td>
                        <td className="p-2 relative">
                          <div className="flex items-center gap-1">
                            <select
                              value={w.reason || ""}
                              onChange={(ev) => setRowReason(it.id, ev.target.value)}
                              onKeyDown={(ev) => {
                                // Arrows navigate between cells;
                                // click / Space still open the dropdown
                                // natively for picking a value.
                                if (ev.key === "ArrowLeft") { ev.preventDefault(); focusCell("wastage-qty", it.id); }
                                else if (ev.key === "ArrowUp") {
                                  ev.preventDefault();
                                  const idx = flatVisibleItemIds.indexOf(it.id);
                                  const prev = flatVisibleItemIds[idx - 1];
                                  if (prev) focusPicker("wastage-reason", prev);
                                } else if (ev.key === "ArrowDown") {
                                  ev.preventDefault();
                                  const idx = flatVisibleItemIds.indexOf(it.id);
                                  const next = flatVisibleItemIds[idx + 1];
                                  if (next) focusPicker("wastage-reason", next);
                                }
                              }}
                              className={`iu-input !h-8 !px-2 text-xs flex-1 min-w-0 text-slate-700 ${w.reason ? "font-semibold" : "text-slate-400"}`}
                              data-testid={`entry-wastage-reason-${it.id}`}
                              title="Why this stock was lost. Click or press Space to pick; arrow keys move between cells."
                            >
                              <option value="">— pick reason —</option>
                              {reasons.map((r) => (
                                <option key={r} value={r}>{r}</option>
                              ))}
                            </select>
                            {/* Notes icon — subtle when empty, rose when
                                a note exists. Hover shows the note as a
                                native tooltip; click opens a popover to
                                edit it. */}
                            <button
                              type="button"
                              onClick={() => setNotesEditor(notesEditor === it.id ? null : it.id)}
                              title={w.notes ? `Note: ${w.notes}` : "Add a note about why this was wasted"}
                              className={`shrink-0 p-1 rounded transition ${w.notes ? "text-rose-500 hover:bg-rose-100" : "text-slate-300 hover:text-slate-600 hover:bg-slate-100"}`}
                              data-testid={`entry-wastage-notes-btn-${it.id}`}
                            >
                              <StickyNote size={13}/>
                            </button>
                          </div>
                          {notesEditor === it.id && (
                            <div className="absolute right-0 top-full mt-1 z-40 w-64 bg-white border border-slate-300 rounded-lg shadow-lg p-2" data-testid={`entry-wastage-notes-popover-${it.id}`}>
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Note · {it.name}</span>
                                <button type="button" onClick={() => setNotesEditor(null)} className="p-0.5 rounded hover:bg-slate-100 text-slate-400" title="Close">
                                  <X size={12}/>
                                </button>
                              </div>
                              <textarea
                                autoFocus
                                rows={3}
                                value={w.notes || ""}
                                onChange={(ev) => setWastageNotes(it.id, ev.target.value)}
                                placeholder="e.g. left in sun, spoiled"
                                className="iu-input !h-auto !py-1.5 text-xs w-full"
                                data-testid={`entry-wastage-notes-textarea-${it.id}`}
                              />
                            </div>
                          )}
                        </td>
                        <td className="p-2 text-right font-semibold tabular-nums text-rose-700" data-testid={`entry-wastage-amt-${it.id}`}>
                          {wasteAmt > 0 ? `₹${inr(wasteAmt)}` : ""}
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
            // Refresh master list, stamp the newly-created vendor onto
            // the row that opened the modal (which also seeds it as
            // the sticky last-used default for the next blank row),
            // then close.
            setVendors((prev) => [...prev, vendor].sort((a, b) => a.name.localeCompare(b.name)));
            if (showAddVendor?.itemId) setRowVendor(showAddVendor.itemId, vendor.id);
            setShowAddVendor(null);
            refreshVendors();
          }}
        />
      )}
      {scorecardVendorId && (
        <VendorScorecardDrawer
          vendorId={scorecardVendorId}
          onClose={() => setScorecardVendorId(null)}
          onOpenItem={(itemId, name) => {
            setScorecardVendorId(null);
            setTrendItem({ id: itemId, name });
          }}
        />
      )}
      {trendItem && (
        <ItemPriceTrendDrawer
          itemId={trendItem.id}
          itemName={trendItem.name}
          onClose={() => setTrendItem(null)}
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
                  <th className="text-right p-2 hidden sm:table-cell">Cons. lines</th>
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
