/**
 * MealMastersTab — tree master for Pantry Stock: Categories → Items.
 *
 * One place to create/rename/deactivate categories and items, move an
 * item to another category, and drag-and-drop reorder items within a
 * category. Each item shows a read-only hint (unit + stock-on-hand);
 * each category shows its item count. Admin edits; chefs read-only.
 *
 * Self-contained pieces (inline editors, AddItemForm, ItemRow,
 * NutritionEditorModal, helpers) live in ./meal-masters/ — extracted
 * 25 Jun 2026 to keep this file focused on the tree orchestration.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Loader2, Folder, FolderOpen, ChevronRight, ChevronDown, Plus, Pencil,
  Power, Trash2, EyeOff, AlertTriangle, ArrowUp, ArrowDown, TrendingUp,
} from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { isUserEditing } from "../../hooks/useMealsEvents";
import { useAuth } from "../../auth";
import { CategoryDetailPanel } from "./MealNodeDetail";
import ItemLedgerDrawer from "./ItemLedgerDrawer";
import ShoppingListPanel from "../../components/ShoppingListPanel";
import { fmtRs, COL_GRID } from "./meal-masters/helpers";
import { InlineEdit } from "./meal-masters/InlineEditors";
import AddItemForm from "./meal-masters/AddItemForm";
import ItemRow from "./meal-masters/ItemRow";
import StockLedgersPrintButton from "./StockLedgersPrintButton";
import { todayIso } from "../../utils";

export default function MealMastersTab({ liveSig }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [subcats, setSubcats] = useState([]);
  const [addingSubCat, setAddingSubCat] = useState(null);
  const [newSubName, setNewSubName] = useState("");
  const subcatsByCat = React.useMemo(() => {
    const m = new Map();
    (subcats || []).forEach((s) => { if (!m.has(s.category_key)) m.set(s.category_key, []); m.get(s.category_key).push(s); });
    return m;
  }, [subcats]);
  const addSubcat = async (category_key) => {
    const name = newSubName.trim();
    if (!name) return;
    try { await api.post("/meals/subcategories", { category_key, name }); setNewSubName(""); setAddingSubCat(null); await load(); }
    catch (err) { showApiError(err, "Couldn't add sub-category"); }
  };
  const deleteSubcat = async (s) => {
    if (!window.confirm(`Delete sub-category "${s.name}"? Items in it move to Ungrouped.`)) return;
    try { await api.del(`/meals/subcategories/${s.id}`); await load(); }
    catch (err) { showApiError(err, "Couldn't delete"); }
  };
  const [units, setUnits] = useState(["kg", "g", "L", "mL", "pcs", "dozen", "packet"]);
  const [stockMap, setStockMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);       // null = all expanded initially
  const [showInactive, setShowInactive] = useState(false);
  const [lowOnly, setLowOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [asOf, setAsOf] = useState("");
  const [renamingCat, setRenamingCat] = useState(null);
  const [addingItemCat, setAddingItemCat] = useState(null);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [drag, setDrag] = useState(null);               // {catKey, itemId, overId}
  const [detail, setDetail] = useState(null);           // {type:'item'|'cat', id}
  const [shop, setShop] = useState(null);               // reorder suggestions

  const load = async (asOfVal = asOf) => {
    try {
      const [c, i, s, rs, sc] = await Promise.all([
        api.get("/meals/purchase-categories"),
        api.get("/meals/items?include_inactive=true"),
        api.get(`/meals/stock${asOfVal ? `?as_of=${asOfVal}` : ""}`),
        api.get("/meals/reorder-suggestions"),
        api.get("/meals/subcategories"),
      ]);
      setShop(rs);
      setCats(c.categories || []);
      setItems(i.items || []);
      setSubcats(sc.subcategories || []);
      if (i.units?.length) setUnits(i.units);
      const m = {};
      (s.rows || []).forEach((r) => { m[r.item_id] = r; });
      setStockMap(m);
    } catch (err) {
      showApiError(err, "Couldn't load masters");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(asOf); }, [asOf]);

  // Live refresh — another machine changed pantry data. Deferred while
  // the user is typing in an inline editor so it never clobbers an edit.
  useEffect(() => {
    if (!liveSig) return;
    let cancelled = false;
    const attempt = () => {
      if (cancelled) return;
      if (isUserEditing()) { setTimeout(attempt, 4000); return; }
      load();
    };
    attempt();
    return () => { cancelled = true; };
  }, [liveSig]);

  const isExpanded = (key) => (expanded == null ? true : expanded.has(key));
  const toggleExpand = (key) => {
    const next = new Set(expanded == null ? cats.map((c) => c.key) : expanded);
    if (next.has(key)) next.delete(key); else next.add(key);
    setExpanded(next);
  };

  const itemsByCat = useMemo(() => {
    const q = search.trim().toLowerCase();
    const m = new Map();
    items.forEach((it) => {
      if (!showInactive && it.active === false) return;
      if (lowOnly && !stockMap[it.id]?.low) return;
      if (q && !(it.name || "").toLowerCase().includes(q)) return;
      if (!m.has(it.category_key)) m.set(it.category_key, []);
      m.get(it.category_key).push(it);
    });
    return m;
  }, [items, showInactive, lowOnly, stockMap, search]);

  // Roll up per-category amounts (opening / purchases / issues / closing)
  // from the item-level stock rows. Only amounts are shown at the category
  // level — qty roll-ups would mix incompatible units (kg + L + pcs).
  const catTotals = useMemo(() => {
    const m = new Map();
    items.forEach((it) => {
      const s = stockMap[it.id];
      if (!s) return;
      const t = m.get(it.category_key) || { opening_value: 0, purchased_amount: 0, issued_value: 0, on_hand_value: 0 };
      t.opening_value += Number(s.opening_value) || 0;
      t.purchased_amount += Number(s.purchased_amount) || 0;
      t.issued_value += Number(s.issued_value) || 0;
      t.on_hand_value += Number(s.on_hand_value) || 0;
      m.set(it.category_key, t);
    });
    return m;
  }, [items, stockMap]);

  // Grand-total across all categories, used by the fixed row at the top
  // of the tree. Sums the same fields the sticky header exposes.
  const grandTotals = useMemo(() => {
    const t = { opening_value: 0, purchased_amount: 0, issued_value: 0, on_hand_value: 0 };
    for (const v of catTotals.values()) {
      t.opening_value += v.opening_value || 0;
      t.purchased_amount += v.purchased_amount || 0;
      t.issued_value += v.issued_value || 0;
      t.on_hand_value += v.on_hand_value || 0;
    }
    return t;
  }, [catTotals]);

  const visibleCats = useMemo(
    () => cats.filter((c) => showInactive || c.active !== false),
    [cats, showInactive],
  );

  // ---- category ops (whole-list PUT, matching the backend contract) ----
  const saveCats = async (next, okMsg) => {
    try {
      const r = await api.put("/meals/purchase-categories", { categories: next });
      setCats(r.categories || []);
      if (okMsg) toast.success(okMsg);
    } catch (err) {
      showApiError(err, "Couldn't save categories");
    }
  };
  const addCategory = () => {
    const label = newCatLabel.trim();
    if (!label) return;
    saveCats([...cats, { label }], `Added ${label}`);
    setNewCatLabel("");
  };
  const renameCategory = (key, label) =>
    saveCats(cats.map((c) => (c.key === key ? { ...c, label } : c)), "Renamed");
  const toggleCategory = (key, active) =>
    saveCats(cats.map((c) => (c.key === key ? { ...c, active } : c)),
             active ? "Category reactivated" : "Category deactivated");
  // ---- category reorder (up/down + auto by consumption) ------------
  const moveCategory = async (key, dir) => {
    const idx = cats.findIndex((c) => c.key === key);
    if (idx < 0) return;
    const swap = idx + (dir === "up" ? -1 : 1);
    if (swap < 0 || swap >= cats.length) return;
    // Optimistic swap so the row visibly hops even before the round-trip.
    const nextCats = cats.slice();
    [nextCats[idx], nextCats[swap]] = [nextCats[swap], nextCats[idx]];
    setCats(nextCats);
    try {
      const r = await api.put("/meals/purchase-categories/reorder",
                              { keys: nextCats.map((c) => c.key) });
      setCats(r.categories || nextCats);
    } catch (err) {
      // Roll back and yell — reorder is a UI-only mistake, no data loss.
      setCats(cats);
      showApiError(err, "Couldn't reorder categories");
    }
  };
  const sortItems = async (mode) => {
    // mode: "consumption" | "alpha". Categories keep their manual
    // order — 20 Feb 2026 clarification: chefs want their walk-through
    // order preserved and only items renumbered inside each folder.
    const label = mode === "alpha" ? "alphabetically (A→Z)" : "by 30-day purchase quantity (busiest first)";
    if (!window.confirm(`Re-sort items inside every category ${label}? Category order stays as you set it.`)) return;
    try {
      const r = await api.post("/meals/items/sort-within-categories", null,
                               { params: { by: mode, days: 90 } });
      toast.success(
        mode === "alpha"
          ? `Sorted ${r.items_renumbered} items A→Z across ${r.categories_touched} categor${r.categories_touched === 1 ? "y" : "ies"}`
          : `Sorted ${r.items_renumbered} items by 90-day purchase across ${r.categories_touched} categor${r.categories_touched === 1 ? "y" : "ies"}`
      );
      await load();
    } catch (err) {
      showApiError(err, "Couldn't sort items");
    }
  };

  // ---- item ops ----
  const patchItem = async (id, patch) => {
    // If we no longer have this item in local state (e.g. SSE reload
    // dropped it while the user's dropdown/inline editor was still open),
    // skip the round-trip and self-heal quietly. Prevents an "Item not
    // found" flash when a peer chef just deleted the same row.
    if (!items.some((i) => i.id === id)) {
      await load();
      return;
    }
    try {
      await api.patch(`/meals/items/${id}`, patch);
      await load();
      if (patch.category_key) toast.success("Item moved");
    } catch (err) {
      if (err?.status === 404) {
        // Another admin deleted this item between the two calls. Reload
        // silently so the row disappears without an error toast.
        toast.message("Item was removed by another user — list refreshed");
        await load();
        return;
      }
      showApiError(err, "Couldn't update item");
    }
  };
  const deleteItem = async (item) => {
    if (!window.confirm(`Delete "${item.name}"? Only works when there is no purchase/issue/wastage history — items with data must be Deactivated (⏻) instead.`)) return;
    // Same stale-guard as patchItem — if the row has already vanished
    // locally, don't fire a doomed request.
    if (!items.some((i) => i.id === item.id)) {
      await load();
      return;
    }
    try {
      const r = await api.del(`/meals/items/${item.id}`);
      if (r.already_deleted) {
        toast.success(`"${item.name}" was already deleted`);
      } else {
        toast.success("Item deleted");
      }
      await load();
    } catch (err) {
      if (err?.status === 404) {
        // Idempotent success: someone else already deleted it.
        toast.success(`"${item.name}" was already deleted`);
        await load();
        return;
      }
      if (err?.status === 409) {
        // Server refused because the item has history. Surface the
        // full explanation and nudge toward the Deactivate button.
        toast.error(err?.message || "This item has data and can't be deleted. Use Deactivate instead.", { duration: 8000 });
        return;
      }
      showApiError(err, "Couldn't delete item");
    }
  };

  // ---- move ONE item up or down within its category (button-driven) ----
  const moveItem = async (item, dir) => {
    const list = items.filter((i) => i.category_key === item.category_key).map((i) => i.id);
    const idx = list.indexOf(item.id);
    if (idx < 0) return;
    const swap = idx + (dir === "up" ? -1 : 1);
    if (swap < 0 || swap >= list.length) return;
    [list[idx], list[swap]] = [list[swap], list[idx]];
    // Optimistic
    setItems((prev) => {
      const ord = new Map(list.map((id, i) => [id, i]));
      return prev.slice().sort((a, b) => {
        if (a.category_key !== item.category_key || b.category_key !== item.category_key) return 0;
        return (ord.get(a.id) ?? 999) - (ord.get(b.id) ?? 999);
      });
    });
    try {
      await api.put("/meals/items/reorder", { category_key: item.category_key, item_ids: list });
    } catch (err) {
      if (err?.status === 404 || err?.status === 400) {
        toast.message("Some items have moved — list refreshed");
      } else {
        showApiError(err, "Couldn't move item");
      }
      await load();
    }
  };

  // ---- drag-and-drop reorder within a category ----
  const dropOn = async (catKey, targetId) => {
    if (!drag || drag.catKey !== catKey || drag.itemId === targetId) { setDrag(null); return; }
    // Reorder against the FULL category list (not the filtered view) so
    // hidden items (inactive / not-low) keep their relative slots.
    const list = items.filter((i) => i.category_key === catKey).map((i) => i.id);
    const from = list.indexOf(drag.itemId);
    const to = list.indexOf(targetId);
    if (from < 0 || to < 0) { setDrag(null); return; }
    list.splice(to, 0, list.splice(from, 1)[0]);
    setDrag(null);
    // optimistic local reorder
    setItems((prev) => {
      const order = new Map(list.map((id, idx) => [id, idx]));
      return prev.slice().sort((a, b) => {
        if (a.category_key !== catKey || b.category_key !== catKey) return 0;
        return (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999);
      });
    });
    try {
      await api.put("/meals/items/reorder", { category_key: catKey, item_ids: list });
    } catch (err) {
      // 404 = whole category gone; 400 = no valid ids left (all items
      // moved/deleted elsewhere). Either way: silent reconcile.
      if (err?.status === 404 || err?.status === 400) {
        toast.message("Some items have moved — list refreshed");
      } else {
        showApiError(err, "Couldn't save the new order");
      }
      await load();
    }
  };

  if (loading) return <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>;

  return (
    <div data-testid="meal-masters-tab">
      <ShoppingListPanel data={shop}/>

      <div className="iu-card p-0" data-testid="masters-tree">
        {/* Sticky header — everything the user needs above the list stays
            latched to the top while scrolling: page-scoped filter toolbar
            (Stock as of / Only low / Show inactive), column labels, and
            the Grand Total roll-up. */}
        <div className="sticky top-[104px] z-20 bg-white border-b border-slate-200 shadow-sm" data-testid="masters-tree-header">
          {/* Row 1 — filter toolbar */}
          <div className="flex items-center gap-3 pl-3 pr-5 py-2 flex-wrap border-b border-slate-100">
            <p className="text-xs text-slate-500">
              {isAdmin
                ? "Manage categories and items in one tree. Use ↑ ↓ buttons or drag to reorder."
                : "Read-only view of the pantry masters."}
            </p>
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search item…"
                className="iu-input !h-7 text-xs !w-48 !pr-6"
                data-testid="masters-search"
                title="Filter the tree to items whose name matches"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-sm leading-none"
                  title="Clear search"
                  data-testid="masters-search-clear"
                >×</button>
              )}
            </div>
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer" title="Show stock on hand as it stood on a past date">
              Stock as of
              <input
                type="date"
                value={asOf}
                max={todayIso()}
                onChange={(e) => setAsOf(e.target.value)}
                className="iu-input !h-7 !w-auto text-xs"
                data-testid="masters-as-of"
              />
              {asOf && (
                <button onClick={() => setAsOf("")} className="text-[10px] font-bold text-slate-400 hover:text-slate-600" title="Back to today's stock">reset</button>
              )}
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-rose-700 cursor-pointer" title="Show only items at or below their minimum stock level">
              <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} data-testid="masters-low-only"/>
              <AlertTriangle size={12}/> Only low stock
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer" title="Include deactivated categories and items in the tree">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} data-testid="masters-show-inactive"/>
              <EyeOff size={12}/> Show inactive
            </label>
            <StockLedgersPrintButton />
            {isAdmin && (
              <span className="inline-flex items-stretch rounded-lg overflow-hidden border border-sky-200 shadow-sm">
                <button
                  onClick={() => sortItems("consumption")}
                  className="inline-flex items-center gap-1.5 px-2.5 h-7 text-xs font-bold bg-sky-100 text-sky-800 hover:bg-sky-200 transition"
                  title="Reorder items INSIDE each category by 90-day purchase quantity — busiest first. Categories stay in your manual order."
                  data-testid="masters-sort-items-consumption"
                >
                  <TrendingUp size={12}/> Sort items · busiest
                </button>
                <button
                  onClick={() => sortItems("alpha")}
                  className="inline-flex items-center gap-1 px-2 h-7 text-xs font-bold bg-white text-sky-800 hover:bg-sky-50 border-l border-sky-200 transition"
                  title="Reorder items INSIDE each category alphabetically (A → Z). Categories stay in your manual order."
                  data-testid="masters-sort-items-alpha"
                >
                  A→Z
                </button>
              </span>
            )}
          </div>
          {/* Row 2 — column labels */}
          <div className="flex items-center gap-2 pl-3 pr-5 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-gradient-to-b from-slate-100 to-slate-50">
            {/* LOW-flag slot (extreme-left) — an empty box keeps the grid
                aligned with rows that DO carry the LOW pill. */}
            <span className="w-6 shrink-0"/>
            <span className="flex-1">Item / Category</span>
            <span className={`${COL_GRID} items-center`}>
              <span className="text-center">Unit</span>
              <span className="text-right" title="Opening stock — click any item's value to edit">Opening <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
              <span className="text-right" title="Low-stock alert level — click any item's value to edit">Min</span>
              <span className="text-right" title="Norm per serving — expected qty per meal (used by Cross-check). Click any item's value to edit">Norm</span>
              <span className="text-right text-emerald-600">Purch <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
              <span className="text-right text-amber-600">Consumed <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
              <span className="text-right text-slate-700">Close <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
            </span>
          </div>
          {/* Grand-totals row — sums ALL visible category totals so the
              admin sees the pantry's overall opening/purch/issue/closing
              value at a glance without collapsing categories. Amounts
              only (qty roll-ups impossible across mixed units). */}
          <div className="flex items-center gap-2 pl-3 pr-5 py-1.5 bg-amber-200 border-t border-amber-300" data-testid="masters-grand-totals">
            <span className="w-6 shrink-0"/>
            <span className="flex-1 text-[11px] font-bold uppercase tracking-wider text-amber-900">
              Grand total <span className="text-[10px] font-semibold text-amber-800/80 normal-case">· {visibleCats.length} categor{visibleCats.length === 1 ? "y" : "ies"} · {items.filter((it) => showInactive || it.active !== false).length} items</span>
            </span>
            <span className={`${COL_GRID} text-[11px] tabular-nums items-center`}>
              <span/>
              <span className="text-right font-bold text-amber-900" title="Sum of opening stock value across ALL categories">{fmtRs(grandTotals.opening_value)}</span>
              <span/>
              <span/>
              <span className="text-right font-bold text-amber-900" title="Sum of total purchase amounts across ALL categories">{fmtRs(grandTotals.purchased_amount)}</span>
              <span className="text-right font-bold text-amber-900" title="Sum of total issue values across ALL categories">{fmtRs(grandTotals.issued_value)}</span>
              <span className="text-right font-bold text-amber-900" title="Sum of closing stock value across ALL categories">{fmtRs(grandTotals.on_hand_value)}</span>
            </span>
          </div>
        </div>

        <div className="p-3 space-y-1">
        {visibleCats.map((cat, catIdx) => {
          const catItems = itemsByCat.get(cat.key) || [];
          if ((lowOnly || search.trim()) && catItems.length === 0) return null;
          const open = search.trim() ? true : isExpanded(cat.key);
          const catInactive = cat.active === false;
          const totals = catTotals.get(cat.key) || { opening_value: 0, purchased_amount: 0, issued_value: 0, on_hand_value: 0 };
          return (
            <div key={cat.key} data-testid={`masters-cat-${cat.key}`}>
              <div className={`flex items-center gap-2 px-2 py-2 rounded-lg bg-amber-100 hover:bg-amber-200 group ${catInactive ? "opacity-60" : ""}`}>
                {/* Extreme-left slot mirrors the item rows' LOW pill area
                    so category and item cells line up. Kept empty for
                    categories — LOW is a per-item concept. */}
                <span className="w-6 shrink-0"/>
                <button onClick={() => toggleExpand(cat.key)} className="p-0.5 rounded hover:bg-white text-slate-500" data-testid={`masters-cat-expand-${cat.key}`}>
                  {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
                </button>
                {isAdmin && (
                  <span className="flex items-center gap-0.5 shrink-0" data-testid={`masters-cat-ops-${cat.key}`}>
                    <button
                      onClick={() => moveCategory(cat.key, "up")}
                      disabled={catIdx === 0}
                      className="p-1 rounded hover:bg-white text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move category up"
                      data-testid={`masters-cat-up-${cat.key}`}
                    ><ArrowUp size={13}/></button>
                    <button
                      onClick={() => moveCategory(cat.key, "down")}
                      disabled={catIdx === visibleCats.length - 1}
                      className="p-1 rounded hover:bg-white text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Move category down"
                      data-testid={`masters-cat-down-${cat.key}`}
                    ><ArrowDown size={13}/></button>
                    <button onClick={() => { setAddingItemCat(cat.key); if (!open) toggleExpand(cat.key); }} className="p-1 rounded hover:bg-emerald-100 text-emerald-600" title="Add item" data-testid={`masters-cat-add-item-${cat.key}`}><Plus size={13}/></button>
                    <button onClick={() => setRenamingCat(cat.key)} className="p-1 rounded hover:bg-white text-slate-500" title="Rename" data-testid={`masters-cat-rename-btn-${cat.key}`}><Pencil size={13}/></button>
                    <button
                      onClick={() => toggleCategory(cat.key, catInactive)}
                      className={`p-1 rounded ${catInactive ? "hover:bg-emerald-100 text-emerald-600" : "hover:bg-amber-100 text-amber-600"}`}
                      title={catInactive ? "Reactivate category" : "Deactivate category (hides from entry dropdowns; items stay)"}
                      data-testid={`masters-cat-toggle-${cat.key}`}
                    ><Power size={13}/></button>
                  </span>
                )}
                {open ? <FolderOpen size={16} className="text-amber-500 shrink-0"/> : <Folder size={16} className="text-amber-500 shrink-0"/>}
                {renamingCat === cat.key ? (
                  <InlineEdit
                    value={cat.label}
                    testid={`masters-cat-rename-${cat.key}`}
                    onSave={(v) => { if (v && v !== cat.label) renameCategory(cat.key, v); setRenamingCat(null); }}
                    onCancel={() => setRenamingCat(null)}
                  />
                ) : (
                  <button onClick={() => setDetail({ type: "cat", id: cat.key })} className="font-bold text-sm text-slate-900 hover:text-emerald-700 hover:underline underline-offset-2" data-testid={`masters-cat-open-${cat.key}`} title="View category totals">
                    {cat.label}
                  </button>
                )}
                <span className="text-[10px] font-bold text-slate-500 bg-slate-100 px-1.5 h-4 rounded-full inline-flex items-center" data-testid={`masters-cat-count-${cat.key}`}>
                  {catItems.length} {catItems.length === 1 ? "item" : "items"}
                </span>
                {catInactive && (
                  <span className="text-[10px] font-bold uppercase text-rose-700 bg-rose-100 px-1.5 h-4 rounded inline-flex items-center">inactive</span>
                )}
                <span className={`ml-auto ${COL_GRID} text-[11px] tabular-nums items-center`} data-testid={`masters-cat-totals-${cat.key}`}>
                  {/* Unit / Min / Norm columns don't apply at the category level
                      (mixed units) — kept empty so the grid lines stay aligned with items. */}
                  <span/>
                  <span className="text-right font-bold text-slate-700" title="Sum of opening stock value across items in this category">{fmtRs(totals.opening_value)}</span>
                  <span/>
                  <span/>
                  <span className="text-right font-bold text-emerald-700" title="Sum of total purchase amounts across items in this category">{fmtRs(totals.purchased_amount)}</span>
                  <span className="text-right font-bold text-amber-700" title="Sum of total issue values across items in this category">{fmtRs(totals.issued_value)}</span>
                  <span className="text-right font-bold text-slate-900" title="Sum of closing stock value across items in this category">{fmtRs(totals.on_hand_value)}</span>
                </span>
              </div>

              {open && (
                <div className="border-l-2 border-slate-100 ml-4 pb-1">
                  {catItems.length === 0 && addingItemCat !== cat.key && (
                    <p className="ml-8 py-1 text-xs text-slate-400 italic">No items yet.</p>
                  )}
                  {(() => {
                    const catSubs = subcatsByCat.get(cat.key) || [];
                    const idxOf = (id) => catItems.findIndex((x) => x.id === id);
                    const renderRow = (it) => {
                      const itIdx = idxOf(it.id);
                      return (
                        <ItemRow
                          key={it.id}
                          item={it}
                          stock={stockMap[it.id]}
                          cats={cats}
                          subcats={catSubs}
                          isAdmin={isAdmin}
                          onPatch={patchItem}
                          onDelete={deleteItem}
                          onOpen={(id) => setDetail({ type: "item", id })}
                          onMoveUp={() => moveItem(it, "up")}
                          onMoveDown={() => moveItem(it, "down")}
                          canMoveUp={itIdx > 0}
                          canMoveDown={itIdx < catItems.length - 1}
                          dnd={{
                            over: drag?.overId === it.id && drag?.catKey === cat.key && drag?.itemId !== it.id,
                            onDragStart: () => setDrag({ catKey: cat.key, itemId: it.id }),
                            onDragOver: (e) => { e.preventDefault(); if (drag && drag.catKey === cat.key) setDrag({ ...drag, overId: it.id }); },
                            onDrop: (e) => { e.preventDefault(); dropOn(cat.key, it.id); },
                            onDragEnd: () => setDrag(null),
                          }}
                        />
                      );
                    };
                    if (catSubs.length === 0) return catItems.map(renderRow);
                    const groups = catSubs.map((s) => ({ s, list: catItems.filter((it) => it.subcategory_key === s.key) }));
                    const grouped = new Set(catSubs.map((s) => s.key));
                    const ungrouped = catItems.filter((it) => !it.subcategory_key || !grouped.has(it.subcategory_key));
                    return (
                      <>
                        {groups.map(({ s, list }) => (
                          <div key={s.id} data-testid={`masters-subcat-${cat.key}-${s.key}`}>
                            <div className="flex items-center gap-2 ml-6 mt-1 mb-0.5">
                              <span className="text-[10px] font-black uppercase tracking-wider text-emerald-700">{s.name}</span>
                              <span className="text-[9px] font-bold text-slate-400">{list.length}</span>
                              {isAdmin && <button onClick={() => deleteSubcat(s)} className="text-slate-300 hover:text-rose-600" title="Delete sub-category" data-testid={`masters-subcat-del-${s.id}`}><Trash2 size={11} /></button>}
                            </div>
                            {list.length === 0 ? <p className="ml-8 py-0.5 text-[11px] text-slate-300 italic">empty</p> : list.map(renderRow)}
                          </div>
                        ))}
                        {ungrouped.length > 0 && (
                          <div>
                            <div className="ml-6 mt-1 mb-0.5 text-[10px] font-black uppercase tracking-wider text-slate-400">Ungrouped</div>
                            {ungrouped.map(renderRow)}
                          </div>
                        )}
                      </>
                    );
                  })()}
                  {isAdmin && (
                    addingSubCat === cat.key ? (
                      <div className="flex items-center gap-1 ml-6 mt-1.5">
                        <input autoFocus value={newSubName} onChange={(e) => setNewSubName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addSubcat(cat.key); if (e.key === "Escape") { setAddingSubCat(null); setNewSubName(""); } }} placeholder="Sub-category name…" className="iu-input !h-7 !w-44 text-xs" data-testid={`masters-subcat-input-${cat.key}`} />
                        <button title="Add a new item" onClick={() => addSubcat(cat.key)} className="iu-btn-primary !h-7 !px-2 text-xs" data-testid={`masters-subcat-save-${cat.key}`}>Add</button>
                        <button title="Close without saving" onClick={() => { setAddingSubCat(null); setNewSubName(""); }} className="iu-btn-secondary !h-7 !px-2 text-xs">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => { setAddingSubCat(cat.key); setNewSubName(""); }} className="ml-6 mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 hover:underline" data-testid={`masters-subcat-add-${cat.key}`}><Plus size={12} /> Add sub-category</button>
                    )
                  )}
                  {addingItemCat === cat.key && (
                    <AddItemForm
                      catKey={cat.key}
                      units={units}
                      onDone={async () => { setAddingItemCat(null); await load(); }}
                      onCancel={() => setAddingItemCat(null)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}

        {isAdmin && (
          <div className="flex items-center gap-2 px-2 pt-3 mt-2 border-t border-slate-100">
            <Plus size={14} className="text-slate-400"/>
            <input
              placeholder="New category name…"
              value={newCatLabel}
              onChange={(e) => setNewCatLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCategory()}
              className="iu-input !h-8 !w-56 text-sm"
              data-testid="masters-add-category-input"
            />
            <button onClick={addCategory} disabled={!newCatLabel.trim()} className="iu-btn-primary !h-8 !px-3 text-xs" data-testid="masters-add-category-btn">
              Add category
            </button>
          </div>
        )}
        </div>
      </div>

      {detail?.type === "item" && (() => {
        const it = items.find((x) => x.id === detail.id);
        return (
          <ItemLedgerDrawer
            itemId={detail.id}
            itemName={it?.name}
            unit={it?.unit}
            onClose={() => setDetail(null)}
          />
        );
      })()}
      {detail?.type === "cat" && (
        <CategoryDetailPanel categoryKey={detail.id} stockMap={stockMap} onClose={() => setDetail(null)}/>
      )}
    </div>
  );
}
