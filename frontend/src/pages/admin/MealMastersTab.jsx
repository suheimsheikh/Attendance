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
import { useAuth } from "../../auth";
import { ItemDetailPanel, CategoryDetailPanel } from "./MealNodeDetail";
import ShoppingListPanel from "../../components/ShoppingListPanel";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

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

function AddItemForm({ catKey, units, onDone, onCancel }) {
  const [d, setD] = useState({ name: "", unit: "kg", opening_stock: "", opening_stock_as_of: "", min_stock: "", norm_per_serving: "" });
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

function ItemRow({ item, stock, cats, isAdmin, onPatch, onDelete, onOpen, dnd }) {
  const [renaming, setRenaming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({});
  const inactive = item.active === false;
  const startEdit = () => {
    setD({ unit: item.unit, opening_stock: item.opening_stock,
           opening_stock_as_of: item.opening_stock_as_of || "",
           min_stock: item.min_stock || 0,
           norm_per_serving: item.norm_per_serving || 0 });
    setEditing(true);
  };
  return (
    <div
      className={`ml-8 rounded-lg border ${dnd.over ? "border-emerald-400 bg-emerald-50/60" : "border-transparent"} ${inactive ? "opacity-60" : ""}`}
      draggable={isAdmin && !renaming && !editing}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDrop={dnd.onDrop}
      onDragEnd={dnd.onDragEnd}
      data-testid={`masters-item-${item.id}`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50 rounded-lg group">
        {isAdmin && <GripVertical size={13} className="text-slate-300 group-hover:text-slate-400 cursor-grab shrink-0"/>}
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"/>
        {renaming ? (
          <InlineEdit
            value={item.name}
            testid={`masters-item-rename-${item.id}`}
            onSave={async (v) => { if (v && v !== item.name) await onPatch(item.id, { name: v }); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button onClick={() => onOpen(item.id)} className="font-semibold text-sm text-slate-900 hover:text-emerald-700 hover:underline underline-offset-2 text-left" data-testid={`masters-item-open-${item.id}`} title="View purchase/issue/wastage history">
            {item.name}
          </button>
        )}
        <span className="text-[10px] font-bold uppercase text-slate-500 bg-slate-100 px-1.5 h-4 rounded inline-flex items-center">{item.unit}</span>
        {inactive && (
          <span className="text-[10px] font-bold uppercase text-rose-700 bg-rose-100 px-1.5 h-4 rounded inline-flex items-center">inactive</span>
        )}
        {!inactive && stock && (
          <span
            className={`text-xs tabular-nums font-semibold ${stock.low ? "text-rose-600" : "text-emerald-700"}`}
            title={`Opening ${fmt(stock.opening_stock)} + purchased ${fmt(stock.purchased)} − issued ${fmt(stock.issued)} − wasted ${fmt(stock.wasted)}${stock.min_stock > 0 ? ` · min level ${fmt(stock.min_stock)}` : ""}`}
            data-testid={`masters-item-stock-${item.id}`}
          >
            {fmt(stock.on_hand)} {item.unit} on hand
          </span>
        )}
        {!inactive && stock?.low && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold uppercase text-rose-700 bg-rose-100 px-1.5 h-4 rounded" data-testid={`masters-item-low-${item.id}`}>
            <AlertTriangle size={9}/> low
          </span>
        )}
        {isAdmin && (
          <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <select
              value=""
              onChange={(e) => e.target.value && onPatch(item.id, { category_key: e.target.value })}
              className="iu-input !h-6 !w-auto !py-0 text-[11px]"
              title="Move to another category"
              data-testid={`masters-item-move-${item.id}`}
            >
              <option value="">Move to…</option>
              {cats.filter((c) => c.key !== item.category_key && c.active !== false).map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
            <button onClick={() => setRenaming(true)} className="p-1 rounded hover:bg-slate-200 text-slate-500" title="Rename" data-testid={`masters-item-rename-btn-${item.id}`}><Pencil size={12}/></button>
            <button onClick={startEdit} className="p-1 rounded hover:bg-slate-200 text-slate-500 text-[10px] font-bold" title="Edit unit / opening stock" data-testid={`masters-item-edit-btn-${item.id}`}>⋯</button>
            <button
              onClick={() => onPatch(item.id, { active: inactive })}
              className={`p-1 rounded ${inactive ? "hover:bg-emerald-100 text-emerald-600" : "hover:bg-amber-100 text-amber-600"}`}
              title={inactive ? "Reactivate" : "Deactivate"}
              data-testid={`masters-item-toggle-${item.id}`}
            ><Power size={12}/></button>
            <button onClick={() => onDelete(item)} className="p-1 rounded hover:bg-rose-100 text-rose-500" title="Delete" data-testid={`masters-item-delete-${item.id}`}><Trash2 size={12}/></button>
          </span>
        )}
      </div>
      {editing && (
        <div className="flex items-center gap-2 flex-wrap px-8 pb-2" data-testid={`masters-item-edit-form-${item.id}`}>
          <label className="text-[11px] text-slate-500">Unit</label>
          <select value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} className="iu-input !h-7 !w-auto text-xs">
            {(["kg", "g", "L", "mL", "pcs", "dozen", "packet"]).map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
          <label className="text-[11px] text-slate-500">Opening stock</label>
          <input type="number" min="0" step="any" value={d.opening_stock} onChange={(e) => setD({ ...d, opening_stock: e.target.value })} className="iu-input !h-7 !w-24 text-xs"/>
          <label className="text-[11px] text-slate-500">as of</label>
          <input type="date" value={d.opening_stock_as_of} onChange={(e) => setD({ ...d, opening_stock_as_of: e.target.value })} className="iu-input !h-7 !w-auto text-xs"/>
          <label className="text-[11px] text-slate-500">Min level</label>
          <input type="number" min="0" step="any" value={d.min_stock} onChange={(e) => setD({ ...d, min_stock: e.target.value })} className="iu-input !h-7 !w-20 text-xs" title="Low-stock alert level (0 = off)" data-testid={`masters-item-edit-min-${item.id}`}/>
          <label className="text-[11px] text-slate-500" title="Expected quantity per meal serving — used by the Cross-check tab">Norm/serving</label>
          <input type="number" min="0" step="any" value={d.norm_per_serving} onChange={(e) => setD({ ...d, norm_per_serving: e.target.value })} className="iu-input !h-7 !w-20 text-xs" title="Expected quantity per meal serving (0 = untracked)" data-testid={`masters-item-edit-norm-${item.id}`}/>
          <button
            onClick={async () => {
              await onPatch(item.id, {
                unit: d.unit,
                opening_stock: parseFloat(d.opening_stock) || 0,
                min_stock: parseFloat(d.min_stock) || 0,
                norm_per_serving: parseFloat(d.norm_per_serving) || 0,
                ...(d.opening_stock_as_of ? { opening_stock_as_of: d.opening_stock_as_of } : {}),
              });
              setEditing(false);
            }}
            className="iu-btn-primary !h-7 !px-2 text-xs"
            data-testid={`masters-item-edit-save-${item.id}`}
          ><Check size={12}/> Save</button>
          <button onClick={() => setEditing(false)} className="iu-btn-secondary !h-7 !px-2 text-xs">Cancel</button>
        </div>
      )}
    </div>
  );
}

export default function MealMastersTab() {
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
      showApiError(err, "Couldn't save the new order");
      await load();
    }
  };

  if (loading) return <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>;

  return (
    <div data-testid="meal-masters-tab">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <p className="text-xs text-slate-500">
          {isAdmin
            ? "Manage categories and items in one tree. Drag items to reorder within a category."
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

      <ShoppingListPanel data={shop}/>

      <div className="iu-card p-3 space-y-1" data-testid="masters-tree">
        {visibleCats.map((cat) => {
          const catItems = itemsByCat.get(cat.key) || [];
          if (lowOnly && catItems.length === 0) return null;
          const open = isExpanded(cat.key);
          const catInactive = cat.active === false;
          return (
            <div key={cat.key} data-testid={`masters-cat-${cat.key}`}>
              <div className={`flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-slate-50 group ${catInactive ? "opacity-60" : ""}`}>
                <button onClick={() => toggleExpand(cat.key)} className="p-0.5 rounded hover:bg-slate-200 text-slate-500" data-testid={`masters-cat-expand-${cat.key}`}>
                  {open ? <ChevronDown size={15}/> : <ChevronRight size={15}/>}
                </button>
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
                {isAdmin && (
                  <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => { setAddingItemCat(cat.key); if (!open) toggleExpand(cat.key); }} className="p-1 rounded hover:bg-emerald-100 text-emerald-600" title="Add item" data-testid={`masters-cat-add-item-${cat.key}`}><Plus size={13}/></button>
                    <button onClick={() => setRenamingCat(cat.key)} className="p-1 rounded hover:bg-slate-200 text-slate-500" title="Rename" data-testid={`masters-cat-rename-btn-${cat.key}`}><Pencil size={13}/></button>
                    <button
                      onClick={() => toggleCategory(cat.key, catInactive)}
                      className={`p-1 rounded ${catInactive ? "hover:bg-emerald-100 text-emerald-600" : "hover:bg-amber-100 text-amber-600"}`}
                      title={catInactive ? "Reactivate category" : "Deactivate category (hides from entry dropdowns; items stay)"}
                      data-testid={`masters-cat-toggle-${cat.key}`}
                    ><Power size={13}/></button>
                  </span>
                )}
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

      {detail?.type === "item" && (
        <ItemDetailPanel itemId={detail.id} onClose={() => setDetail(null)}/>
      )}
      {detail?.type === "cat" && (
        <CategoryDetailPanel categoryKey={detail.id} stockMap={stockMap} onClose={() => setDetail(null)}/>
      )}
    </div>
  );
}
