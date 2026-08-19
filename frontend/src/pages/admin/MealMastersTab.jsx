/**
 * MealMastersTab — tree master for Pantry Stock: Categories → Items.
 *
 * One place to create/rename/deactivate categories and items, move an
 * item to another category, and drag-and-drop reorder items within a
 * category. Each item shows a read-only hint (unit + stock-on-hand);
 * each category shows its item count. Admin edits; chefs read-only.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  Loader2, Folder, FolderOpen, ChevronRight, ChevronDown, Plus, Pencil,
  Check, X, GripVertical, Power, Trash2, CornerDownRight, EyeOff, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { isUserEditing } from "../../hooks/useMealsEvents";
import { useAuth } from "../../auth";
import { ItemDetailPanel, CategoryDetailPanel } from "./MealNodeDetail";
import ShoppingListPanel from "../../components/ShoppingListPanel";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
const fmtRs = (n) => (n == null || !Number(n) ? "₹0.00" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function InlineEdit({ value, onSave, onCancel, testid }) {
  const [v, setV] = useState(value);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(v.trim());
          if (e.key === "Escape") onCancel();
        }}
        className="iu-input !h-7 !w-44 text-sm"
        data-testid={testid}
      />
      <button onClick={() => onSave(v.trim())} className="p-1 rounded hover:bg-emerald-100 text-emerald-700" data-testid={`${testid}-save`} title="Save"><Check size={14}/></button>
      <button onClick={onCancel} className="p-1 rounded hover:bg-slate-100 text-slate-500" title="Cancel"><X size={14}/></button>
    </span>
  );
}

// Inline number cell — displays a value, click to turn into an input. Used
// for editable Opening Stock and Min Level columns in the Masters tree so
// admins don't need a separate `⋯` panel. Enter/blur saves, Escape cancels.
function InlineNum({ value, onSave, testid, hint }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? 0);
  useEffect(() => { setV(value ?? 0); }, [value]);
  if (!editing) {
    return (
      <button
        className="w-full text-right px-1 py-0.5 rounded hover:bg-white hover:ring-1 hover:ring-emerald-300 text-slate-800 font-semibold tabular-nums transition"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title={hint || "Click to edit"}
      >
        {value == null || value === "" ? "—" : fmt(value)}
      </button>
    );
  }
  const commit = () => {
    const n = parseFloat(v);
    setEditing(false);
    if (!isNaN(n) && n !== Number(value)) onSave(n);
  };
  return (
    <input
      autoFocus
      type="number"
      min="0"
      step="any"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value ?? 0); setEditing(false); }
      }}
      className="iu-input !h-6 !w-full !py-0 !px-1.5 text-[11px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Tiny inline editor for the opening RATE (₹/unit) shown under the opening
// qty. Values opening stock before an item's first recorded purchase so
// closing / issue valuations aren't ₹0 for opening-only items.
function InlineRate({ value, unit, onSave, testid }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? 0);
  useEffect(() => { setV(value ?? 0); }, [value]);
  if (!editing) {
    return (
      <button
        className="w-full text-right text-[9px] leading-tight tabular-nums text-emerald-700 hover:underline underline-offset-2"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title="Opening rate (₹ per unit) — click to edit. Used to value opening stock before the first purchase."
      >
        {Number(value) > 0 ? `@₹${fmt(value)}/${unit}` : "@₹—"}
      </button>
    );
  }
  const commit = () => {
    const n = parseFloat(v);
    setEditing(false);
    if (!isNaN(n) && n !== Number(value)) onSave(n);
  };
  return (
    <input
      autoFocus type="number" min="0" step="any" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value ?? 0); setEditing(false); }
      }}
      className="iu-input !h-5 !w-full !py-0 !px-1 text-[10px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Inline as-of date pill for opening stock. Shown right under the
// opening qty / rate on Master rows so admins can see + edit when the
// opening balance was struck (Aug 2026 user ask).
function InlineDate({ value, onSave, testid }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  const display = value
    ? new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })
    : "set date";
  if (!editing) {
    return (
      <button
        className="w-full text-right text-[9px] leading-tight tabular-nums text-slate-500 hover:text-slate-700 hover:underline underline-offset-2"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title="Opening stock as-of date — click to edit"
      >
        as of {display}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (v && v !== (value || "")) onSave(v);
  };
  return (
    <input
      autoFocus type="date" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value || ""); setEditing(false); }
      }}
      className="iu-input !h-5 !w-full !py-0 !px-1 text-[10px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Inline unit picker — small transparent-looking select that saves on
// change. Used in the Masters tree Unit column.
function InlineUnit({ value, options, onSave, testid }) {
  return (
    <select
      value={value}
      onChange={(e) => e.target.value !== value && onSave(e.target.value)}
      className="w-full h-6 text-[10px] font-bold uppercase text-slate-600 bg-transparent border border-transparent hover:bg-white hover:ring-1 hover:ring-emerald-300 rounded px-1 text-center transition cursor-pointer"
      data-testid={testid}
      title="Change unit"
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

const UNIT_OPTIONS = ["kg", "g", "L", "mL", "pcs", "dozen", "packet"];

function AddItemForm({ catKey, units, onDone, onCancel }) {
  const [d, setD] = useState({ name: "", unit: "kg", opening_stock: "", opening_stock_as_of: "", opening_rate: "", min_stock: "", norm_per_serving: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!d.name.trim()) { toast.error("Item name is required"); return; }
    setBusy(true);
    try {
      await api.post("/meals/items", {
        category_key: catKey,
        name: d.name.trim(),
        unit: d.unit,
        opening_stock: parseFloat(d.opening_stock) || 0,
        opening_rate: parseFloat(d.opening_rate) || 0,
        min_stock: parseFloat(d.min_stock) || 0,
        norm_per_serving: parseFloat(d.norm_per_serving) || 0,
        ...(d.opening_stock_as_of ? { opening_stock_as_of: d.opening_stock_as_of } : {}),
      });
      toast.success(`Added ${d.name.trim()}`);
      onDone();
    } catch (err) {
      showApiError(err, "Couldn't add item");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-10 my-1 flex items-center gap-2 flex-wrap bg-emerald-50/60 border border-emerald-200 rounded-lg px-3 py-2" data-testid={`masters-add-item-form-${catKey}`}>
      <CornerDownRight size={13} className="text-emerald-600 shrink-0"/>
      <input autoFocus placeholder="Item name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })}
             onKeyDown={(e) => e.key === "Enter" && save()}
             className="iu-input !h-8 !w-40 text-sm" data-testid={`masters-add-item-name-${catKey}`}/>
      <select value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} className="iu-input !h-8 !w-auto text-sm" data-testid={`masters-add-item-unit-${catKey}`}>
        {units.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      <input type="number" min="0" step="any" placeholder="Opening stock" value={d.opening_stock}
             onChange={(e) => setD({ ...d, opening_stock: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" data-testid={`masters-add-item-opening-${catKey}`}/>
      <input type="date" value={d.opening_stock_as_of} onChange={(e) => setD({ ...d, opening_stock_as_of: e.target.value })}
             className="iu-input !h-8 !w-auto text-sm" title="Opening stock as-of date (defaults to today)"/>
      <input type="number" min="0" step="any" placeholder="Opening ₹/unit" value={d.opening_rate}
             onChange={(e) => setD({ ...d, opening_rate: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" title="Cost per unit of the opening stock — values the opening stock before the first purchase (0 = unknown)" data-testid={`masters-add-item-openrate-${catKey}`}/>
      <input type="number" min="0" step="any" placeholder="Min level" value={d.min_stock}
             onChange={(e) => setD({ ...d, min_stock: e.target.value })}
             className="iu-input !h-8 !w-24 text-sm" title="Low-stock alert level (0 = off)" data-testid={`masters-add-item-min-${catKey}`}/>
      <input type="number" min="0" step="any" placeholder="Norm/serving" value={d.norm_per_serving}
             onChange={(e) => setD({ ...d, norm_per_serving: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" title="Expected quantity per meal serving — used by the Cross-check tab (0 = untracked)" data-testid={`masters-add-item-norm-${catKey}`}/>
      <button onClick={save} disabled={busy} className="iu-btn-primary !h-8 !px-3 text-xs" data-testid={`masters-add-item-save-${catKey}`}>
        {busy ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>} Add
      </button>
      <button onClick={onCancel} className="iu-btn-secondary !h-8 !px-3 text-xs">Cancel</button>
    </div>
  );
}

// Shared column widths so the sticky header, category rows and item rows
// all line up in a single grid — 7 numeric columns on the right.
// Unit(w-14) Opening(w-24) Min(w-20) Norm(w-20) Purch(w-32) Issue(w-32) Close(w-32).
const COL_GRID = "grid grid-cols-[3.5rem_6rem_5rem_5rem_8rem_8rem_8rem] gap-x-4 shrink-0";

function ItemRow({ item, stock, cats, isAdmin, onPatch, onDelete, onOpen, dnd }) {
  const [renaming, setRenaming] = useState(false);
  const inactive = item.active === false;
  const showStock = !inactive && stock;
  return (
    <div
      className={`rounded-lg border ${dnd.over ? "border-emerald-400 bg-emerald-50/60" : "border-transparent"} ${inactive ? "opacity-60" : ""}`}
      draggable={isAdmin && !renaming}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDrop={dnd.onDrop}
      onDragEnd={dnd.onDragEnd}
      data-testid={`masters-item-${item.id}`}
    >
      {/* Indent moved from outer `ml-6` to inner `pl-8` (was `px-2`) so
          the item row occupies the SAME width as category / grand-total
          rows — otherwise the right-aligned stat grid ended 24px shy of
          the category grid, breaking column alignment (Feb 2026 fix). */}
      <div className="flex items-center gap-2 pl-8 pr-2 py-1.5 hover:bg-slate-200/70 rounded-lg group">
        {/* Extreme-left LOW pill — moved here from beside the item name so
            it's the first thing you scan and can spot restock candidates
            at a glance without reading the row. Fixed-width slot keeps the
            grid aligned even for items that aren't low. */}
        <span className="w-6 shrink-0 flex justify-center" data-testid={`masters-item-lowcell-${item.id}`}>
          {!inactive && stock?.low && (
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-100 text-rose-600" title="Low stock — at or below the minimum level" data-testid={`masters-item-low-${item.id}`}>
              <AlertTriangle size={11}/>
            </span>
          )}
        </span>
        {isAdmin && <GripVertical size={13} className="text-slate-300 group-hover:text-slate-400 cursor-grab shrink-0"/>}
        {isAdmin && (
          <span className="flex items-center gap-0.5 shrink-0" data-testid={`masters-item-ops-${item.id}`}>
            <select
              value=""
              onChange={(e) => e.target.value && onPatch(item.id, { category_key: e.target.value })}
              className="iu-input !h-6 !w-auto !py-0 !px-1 text-[11px]"
              title="Move to another category"
              data-testid={`masters-item-move-${item.id}`}
            >
              <option value="">Move…</option>
              {cats.filter((c) => c.key !== item.category_key && c.active !== false).map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
            <button onClick={() => setRenaming(true)} className="p-1 rounded hover:bg-white text-slate-500" title="Rename" data-testid={`masters-item-rename-btn-${item.id}`}><Pencil size={12}/></button>
            <button
              onClick={() => onPatch(item.id, { active: inactive })}
              className={`p-1 rounded ${inactive ? "hover:bg-emerald-100 text-emerald-600" : "hover:bg-amber-100 text-amber-600"}`}
              title={inactive ? "Reactivate" : "Deactivate"}
              data-testid={`masters-item-toggle-${item.id}`}
            ><Power size={12}/></button>
            <button onClick={() => onDelete(item)} className="p-1 rounded hover:bg-rose-100 text-rose-500" title="Delete" data-testid={`masters-item-delete-${item.id}`}><Trash2 size={12}/></button>
          </span>
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"/>
        {renaming ? (
          <InlineEdit
            value={item.name}
            testid={`masters-item-rename-${item.id}`}
            onSave={async (v) => { if (v && v !== item.name) await onPatch(item.id, { name: v }); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button onClick={() => onOpen(item.id)} className="font-semibold text-sm text-slate-900 hover:text-emerald-700 hover:underline underline-offset-2 text-left truncate" data-testid={`masters-item-open-${item.id}`} title="View purchase / issue / wastage history">
            {item.name}
          </button>
        )}
        {inactive && (
          <span className="text-[10px] font-bold uppercase text-rose-700 bg-rose-100 px-1.5 h-4 rounded inline-flex items-center">inactive</span>
        )}
        <span className={`ml-auto ${COL_GRID} text-[11px] tabular-nums items-center`} data-testid={`masters-item-stock-${item.id}`}>
          {/* Unit — inline editable */}
          {isAdmin ? (
            <InlineUnit
              value={item.unit}
              options={UNIT_OPTIONS}
              onSave={(u) => onPatch(item.id, { unit: u })}
              testid={`masters-item-unit-${item.id}`}
            />
          ) : (
            <span className="text-[10px] font-bold uppercase text-slate-500 text-center">{item.unit}</span>
          )}
          {/* Opening (editable qty + optional editable ₹/unit rate + as-of date) */}
          {isAdmin ? (
            <span className="flex flex-col">
              <InlineNum
                value={item.opening_stock || 0}
                onSave={(n) => onPatch(item.id, { opening_stock: n })}
                testid={`masters-item-opening-${item.id}`}
                hint={`Click to edit opening stock${item.opening_stock_as_of ? ` (as of ${item.opening_stock_as_of})` : ""}`}
              />
              {Number(item.opening_stock) > 0 && (
                <InlineRate
                  value={item.opening_rate || 0}
                  unit={item.unit}
                  onSave={(n) => onPatch(item.id, { opening_rate: n })}
                  testid={`masters-item-openrate-${item.id}`}
                />
              )}
              {Number(item.opening_stock) > 0 && (
                <InlineDate
                  value={item.opening_stock_as_of || ""}
                  onSave={(iso) => onPatch(item.id, { opening_stock_as_of: iso })}
                  testid={`masters-item-openasof-${item.id}`}
                />
              )}
            </span>
          ) : (
            <span className="flex flex-col text-right">
              <span className="font-semibold text-slate-700">{fmt(item.opening_stock || 0)}</span>
              {Number(item.opening_stock) > 0 && Number(item.opening_rate) > 0 && (
                <span className="text-[9px] leading-tight text-emerald-700 tabular-nums">@₹{fmt(item.opening_rate)}/{item.unit}</span>
              )}
              {Number(item.opening_stock) > 0 && item.opening_stock_as_of && (
                <span className="text-[9px] leading-tight text-slate-500 tabular-nums">
                  as of {new Date(item.opening_stock_as_of + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })}
                </span>
              )}
            </span>
          )}
          {/* Min level (editable qty) */}
          {isAdmin ? (
            <InlineNum
              value={item.min_stock || 0}
              onSave={(n) => onPatch(item.id, { min_stock: n })}
              testid={`masters-item-min-${item.id}`}
              hint="Click to edit low-stock alert level (0 = off)"
            />
          ) : (
            <span className="text-right text-slate-500">{fmt(item.min_stock || 0)}</span>
          )}
          {/* Norm per serving (editable qty) — expected quantity of THIS
              item consumed per meal serving. Used by the Cross-check tab
              to compare expected vs actual issues. 0 = untracked. */}
          {isAdmin ? (
            <InlineNum
              value={item.norm_per_serving || 0}
              onSave={(n) => onPatch(item.id, { norm_per_serving: n })}
              testid={`masters-item-norm-${item.id}`}
              hint="Click to edit norm per serving (expected qty per meal — used by Cross-check)"
            />
          ) : (
            <span className="text-right text-slate-500">{fmt(item.norm_per_serving || 0)}</span>
          )}
          {/* Purch qty + ₹ inline */}
          <span className="text-right whitespace-nowrap" title="Total purchases since opening date">
            {showStock ? (
              <>
                <span className="font-semibold text-slate-700">{fmt(stock.purchased)}</span>
                <span className="text-[10px] text-emerald-700 font-medium ml-1.5">{fmtRs(stock.purchased_amount)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
          {/* Issue qty + ₹ inline */}
          <span className="text-right whitespace-nowrap" title="Total kitchen issues since opening date">
            {showStock ? (
              <>
                <span className="font-semibold text-slate-700">{fmt(stock.issued)}</span>
                <span className="text-[10px] text-amber-700 font-medium ml-1.5">{fmtRs(stock.issued_value)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
          {/* Close qty + ₹ inline */}
          <span
            className="text-right whitespace-nowrap"
            title={showStock && stock.avg_rate ? `Valued at ₹${stock.avg_rate}/${item.unit} (weighted-avg cost)` : "Closing stock on hand"}
          >
            {showStock ? (
              <>
                <span className={`font-bold ${stock.low ? "text-rose-600" : "text-emerald-700"}`}>{fmt(stock.on_hand)}</span>
                <span className={`text-[10px] font-medium ml-1.5 ${stock.low ? "text-rose-500" : "text-slate-600"}`}>{fmtRs(stock.on_hand_value)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function MealMastersTab({ liveSig }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [units, setUnits] = useState(["kg", "g", "L", "mL", "pcs", "dozen", "packet"]);
  const [stockMap, setStockMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);       // null = all expanded initially
  const [showInactive, setShowInactive] = useState(false);
  const [lowOnly, setLowOnly] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [renamingCat, setRenamingCat] = useState(null);
  const [addingItemCat, setAddingItemCat] = useState(null);
  const [newCatLabel, setNewCatLabel] = useState("");
  const [drag, setDrag] = useState(null);               // {catKey, itemId, overId}
  const [detail, setDetail] = useState(null);           // {type:'item'|'cat', id}
  const [shop, setShop] = useState(null);               // reorder suggestions

  const load = async (asOfVal = asOf) => {
    try {
      const [c, i, s, rs] = await Promise.all([
        api.get("/meals/purchase-categories"),
        api.get("/meals/items?include_inactive=true"),
        api.get(`/meals/stock${asOfVal ? `?as_of=${asOfVal}` : ""}`),
        api.get("/meals/reorder-suggestions"),
      ]);
      setShop(rs);
      setCats(c.categories || []);
      setItems(i.items || []);
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
    const m = new Map();
    items.forEach((it) => {
      if (!showInactive && it.active === false) return;
      if (lowOnly && !stockMap[it.id]?.low) return;
      if (!m.has(it.category_key)) m.set(it.category_key, []);
      m.get(it.category_key).push(it);
    });
    return m;
  }, [items, showInactive, lowOnly, stockMap]);

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

  // ---- item ops ----
  const patchItem = async (id, patch) => {
    try {
      await api.patch(`/meals/items/${id}`, patch);
      await load();
      if (patch.category_key) toast.success("Item moved");
    } catch (err) {
      if (err?.status === 404) {
        toast.error("That item no longer exists — refreshing the list");
        await load();
        return;
      }
      showApiError(err, "Couldn't update item");
    }
  };
  const deleteItem = async (item) => {
    if (!window.confirm(`Delete "${item.name}"? Items with purchase/issue history are deactivated instead.`)) return;
    try {
      const r = await api.del(`/meals/items/${item.id}`);
      toast.success(r.soft_deleted ? "Item deactivated (has history)" : "Item deleted");
      await load();
    } catch (err) {
      if (err?.status === 404) {
        toast.error("That item no longer exists — refreshing the list");
        await load();
        return;
      }
      showApiError(err, "Couldn't delete item");
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
      if (err?.status === 404) {
        toast.error("An item in this category no longer exists — refreshing the list");
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
                ? "Manage categories and items in one tree. Drag items to reorder."
                : "Read-only view of the pantry masters."}
            </p>
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer" title="Show stock on hand as it stood on a past date">
              Stock as of
              <input
                type="date"
                value={asOf}
                max={new Date().toLocaleDateString("sv-SE")}
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
          </div>
          {/* Row 2 — column labels */}
          <div className="flex items-center gap-2 pl-3 pr-5 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-gradient-to-b from-slate-100 to-slate-50">
            {/* LOW-flag slot (extreme-left) — an empty box keeps the grid
                aligned with rows that DO carry the LOW pill. */}
            <span className="w-6 shrink-0"/>
            <span className="flex-1">Item / Category</span>
            <span className={`${COL_GRID} items-center`}>
              <span className="text-center">Unit</span>
              <span className="text-right" title="Opening stock — click any item's value to edit">Opening</span>
              <span className="text-right" title="Low-stock alert level — click any item's value to edit">Min</span>
              <span className="text-right" title="Norm per serving — expected qty per meal (used by Cross-check). Click any item's value to edit">Norm</span>
              <span className="text-right text-emerald-600">Purch <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
              <span className="text-right text-amber-600">Issue <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>
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
        {visibleCats.map((cat) => {
          const catItems = itemsByCat.get(cat.key) || [];
          if (lowOnly && catItems.length === 0) return null;
          const open = isExpanded(cat.key);
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
                  {catItems.map((it) => (
                    <ItemRow
                      key={it.id}
                      item={it}
                      stock={stockMap[it.id]}
                      cats={cats}
                      isAdmin={isAdmin}
                      onPatch={patchItem}
                      onDelete={deleteItem}
                      onOpen={(id) => setDetail({ type: "item", id })}
                      dnd={{
                        over: drag?.overId === it.id && drag?.catKey === cat.key && drag?.itemId !== it.id,
                        onDragStart: () => setDrag({ catKey: cat.key, itemId: it.id }),
                        onDragOver: (e) => { e.preventDefault(); if (drag && drag.catKey === cat.key) setDrag({ ...drag, overId: it.id }); },
                        onDrop: (e) => { e.preventDefault(); dropOn(cat.key, it.id); },
                        onDragEnd: () => setDrag(null),
                      }}
                    />
                  ))}
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

      {detail?.type === "item" && (
        <ItemDetailPanel itemId={detail.id} onClose={() => setDetail(null)}/>
      )}
      {detail?.type === "cat" && (
        <CategoryDetailPanel categoryKey={detail.id} stockMap={stockMap} onClose={() => setDetail(null)}/>
      )}
    </div>
  );
}
