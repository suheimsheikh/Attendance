/**
 * MealPurchasesTab — items-based daily purchase entry (Feb 2026 rev).
 *
 * Chef picks a date and enters Qty + Rate per item; Amount is derived
 * (qty × rate). Category totals + day total roll up automatically.
 * Admin manages items and categories via modals.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Save, Upload, Settings2, Plus, Trash2, X, FileDown, Boxes,
} from "lucide-react";
import { api, showApiError, uploadFile } from "../../api";
import { useAuth } from "../../auth";
import { formatDate } from "../../utils";

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const inr = (n) =>
  n == null ? "0" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);

// ---------------------------------------------------------------------------
// Categories manager modal (unchanged behaviour from earlier build)
// ---------------------------------------------------------------------------
function CategoryManagerModal({ categories, onClose, onSaved }) {
  const [rows, setRows] = useState(categories.map((c) => ({ ...c })));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const clean = rows.filter((r) => (r.label || "").trim());
    if (!clean.length) { toast.error("At least one category is required"); return; }
    setSaving(true);
    try {
      const res = await api.put("/meals/purchase-categories", { categories: clean });
      toast.success("Categories saved");
      onSaved(res.categories);
      onClose();
    } catch (err) {
      showApiError(err, "Couldn't save categories");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose} data-testid="purchase-cats-backdrop">
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()} data-testid="purchase-cats-modal">
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">Purchase categories</h2>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500" data-testid="purchase-cats-close"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {rows.map((r, i) => (
            <div key={r.key || `new-${i}`} className="flex items-center gap-2">
              <input
                value={r.label}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                className="iu-input !h-9 flex-1 text-sm"
                placeholder="Category name (e.g. Eggs)"
                data-testid={`purchase-cat-input-${i}`}
              />
              <button
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                className="p-2 rounded text-rose-500 hover:bg-rose-50"
                data-testid={`purchase-cat-remove-${i}`}
              ><Trash2 size={15} /></button>
            </div>
          ))}
          <button onClick={() => setRows([...rows, { key: null, label: "" }])} className="iu-btn-secondary !h-9 !px-3 text-sm w-full" data-testid="purchase-cat-add">
            <Plus size={14} /> Add category
          </button>
          <p className="text-[11px] text-slate-400">Renaming or removing keeps historical amounts in the report.</p>
        </div>
        <footer className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button onClick={onClose} className="iu-btn-secondary !h-9 !px-4 text-sm">Cancel</button>
          <button onClick={save} disabled={saving} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="purchase-cats-save">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items manager modal — admin-only. One flat list grouped by category with
// inline edit. Save/create is per-row so a partial edit can't lose siblings.
// ---------------------------------------------------------------------------
function ItemManagerModal({ categories, onClose, onChanged }) {
  const [items, setItems] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ category_key: categories[0]?.key || "", name: "", unit: "kg", opening_stock: 0 });
  const [busy, setBusy] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/meals/items?include_inactive=false");
      setItems(r.items || []);
      setUnits(r.units || []);
    } catch (err) {
      showApiError(err, "Couldn't load items");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const addItem = async () => {
    if (!draft.name.trim()) { toast.error("Item name required"); return; }
    if (!draft.category_key) { toast.error("Choose a category"); return; }
    setBusy("new");
    try {
      await api.post("/meals/items", {
        category_key: draft.category_key,
        name: draft.name.trim(),
        unit: draft.unit,
        opening_stock: Number(draft.opening_stock) || 0,
        opening_stock_as_of: todayISO(),
      });
      toast.success("Item added");
      setDraft({ ...draft, name: "", opening_stock: 0 });
      await load();
      onChanged?.();
    } catch (err) {
      showApiError(err, "Couldn't add item");
    } finally { setBusy(null); }
  };

  const saveRow = async (row, patch) => {
    setBusy(row.id);
    try {
      await api.patch(`/meals/items/${row.id}`, patch);
      toast.success("Saved");
      await load();
      onChanged?.();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally { setBusy(null); }
  };

  const del = async (row) => {
    if (!window.confirm(`Delete item "${row.name}"?`)) return;
    setBusy(row.id);
    try {
      const r = await api.del(`/meals/items/${row.id}`);
      toast.success(r.soft_deleted ? "Item archived (had history)" : "Item deleted");
      await load();
      onChanged?.();
    } catch (err) {
      showApiError(err, "Delete failed");
    } finally { setBusy(null); }
  };

  const grouped = useMemo(() => {
    const m = new Map(categories.map((c) => [c.key, { cat: c, rows: [] }]));
    items.forEach((it) => m.get(it.category_key)?.rows.push(it));
    return Array.from(m.values());
  }, [items, categories]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose} data-testid="items-manager-backdrop">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()} data-testid="items-manager-modal">
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-extrabold">Items master</h2>
            <p className="text-xs text-slate-500 mt-0.5">Sub-categories under each purchase category (e.g. Grocery → Oil).</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-slate-100 text-slate-500" data-testid="items-manager-close"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Add new item */}
          <div className="iu-card p-3 bg-slate-50/50" data-testid="items-new-card">
            <div className="text-xs font-bold text-slate-600 mb-2">Add new item</div>
            <div className="flex flex-wrap gap-2 items-end">
              <select value={draft.category_key} onChange={(e) => setDraft({ ...draft, category_key: e.target.value })} className="iu-input !h-9 text-sm" data-testid="items-new-category">
                {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Item name (e.g. Rice)" className="iu-input !h-9 text-sm flex-1 min-w-[160px]" data-testid="items-new-name" />
              <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} className="iu-input !h-9 text-sm w-24" data-testid="items-new-unit">
                {units.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
              <input type="number" min="0" step="0.01" value={draft.opening_stock} onChange={(e) => setDraft({ ...draft, opening_stock: e.target.value })} placeholder="Opening" className="iu-input !h-9 text-sm w-24" data-testid="items-new-opening" title="Opening stock (in the chosen unit)" />
              <button onClick={addItem} disabled={busy === "new"} className="iu-btn-primary !h-9 !px-3 text-sm" data-testid="items-new-add">
                {busy === "new" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : grouped.every((g) => g.rows.length === 0) ? (
            <div className="text-center py-8 text-sm text-slate-500" data-testid="items-empty">
              No items yet. Add your first item above.
            </div>
          ) : (
            grouped.map(({ cat, rows }) => (
              <section key={cat.key} data-testid={`items-cat-section-${cat.key}`}>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                  {cat.label} <span className="text-slate-400">· {rows.length}</span>
                </h3>
                {rows.length === 0 ? (
                  <div className="text-xs text-slate-400 pl-1">No items.</div>
                ) : (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                        <tr>
                          <th className="text-left p-2">Name</th>
                          <th className="text-left p-2 w-20">Unit</th>
                          <th className="text-right p-2 w-28">Opening</th>
                          <th className="text-left p-2 w-32">As of</th>
                          <th className="p-2 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <ItemRow key={r.id} row={r} units={units} busy={busy === r.id} onSave={(p) => saveRow(r, p)} onDelete={() => del(r)} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function ItemRow({ row, units, busy, onSave, onDelete }) {
  const [name, setName] = useState(row.name);
  const [unit, setUnit] = useState(row.unit);
  const [opening, setOpening] = useState(row.opening_stock);
  const [asOf, setAsOf] = useState(row.opening_stock_as_of || todayISO());
  const dirty = name !== row.name || unit !== row.unit
    || Number(opening) !== Number(row.opening_stock)
    || asOf !== row.opening_stock_as_of;
  return (
    <tr className="border-t border-slate-100" data-testid={`items-row-${row.id}`}>
      <td className="p-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className="iu-input !h-8 text-sm w-full" data-testid={`items-row-name-${row.id}`} />
      </td>
      <td className="p-2">
        <select value={unit} onChange={(e) => setUnit(e.target.value)} className="iu-input !h-8 text-sm w-full" data-testid={`items-row-unit-${row.id}`}>
          {units.map((u) => <option key={u} value={u}>{u}</option>)}
        </select>
      </td>
      <td className="p-2 text-right">
        <input type="number" min="0" step="0.01" value={opening} onChange={(e) => setOpening(e.target.value)} className="iu-input !h-8 text-sm w-full text-right tabular-nums" data-testid={`items-row-opening-${row.id}`} />
      </td>
      <td className="p-2">
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="iu-input !h-8 text-sm w-full" data-testid={`items-row-asof-${row.id}`} />
      </td>
      <td className="p-2 whitespace-nowrap text-right">
        {dirty && (
          <button onClick={() => onSave({ name, unit, opening_stock: Number(opening), opening_stock_as_of: asOf })} disabled={busy} className="p-1.5 rounded text-emerald-700 hover:bg-emerald-50" title="Save" data-testid={`items-row-save-${row.id}`}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          </button>
        )}
        <button onClick={onDelete} disabled={busy} className="p-1.5 rounded text-rose-500 hover:bg-rose-50" title="Delete" data-testid={`items-row-del-${row.id}`}>
          <Trash2 size={14} />
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Purchases tab
// ---------------------------------------------------------------------------
export default function MealPurchasesTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [dateStr, setDateStr] = useState(todayISO());
  const [entries, setEntries] = useState({});       // { item_id: {qty, rate} }
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const [showCatModal, setShowCatModal] = useState(false);
  const [showItemsModal, setShowItemsModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileRef = useRef(null);

  const loadMasters = async () => {
    try {
      const [c, i] = await Promise.all([
        api.get("/meals/purchase-categories"),
        api.get("/meals/items?include_inactive=false"),
      ]);
      setCats((c.categories || []).filter((x) => x.active !== false));
      setItems(i.items || []);
    } catch (err) {
      showApiError(err, "Couldn't load masters");
    }
  };
  useEffect(() => { loadMasters(); }, []);

  const loadRecent = () => {
    const end = todayISO();
    const startD = new Date();
    startD.setDate(startD.getDate() - 30);
    const p = (n) => String(n).padStart(2, "0");
    const start = `${startD.getFullYear()}-${p(startD.getMonth() + 1)}-${p(startD.getDate())}`;
    api.get(`/meals/purchases?start=${start}&end=${end}`)
      .then((r) => setRecent((r.purchases || []).slice().reverse()))
      .catch(() => {});
  };
  useEffect(loadRecent, []);

  // Load lines for the selected date; if the doc only has legacy amounts
  // (no lines), we start with a blank line-item entry (user can fill in
  // qty/rate against items — legacy amounts stay in the report as-is).
  useEffect(() => {
    api.get(`/meals/purchases?start=${dateStr}&end=${dateStr}`)
      .then((r) => {
        const lines = r.purchases?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = { qty: l.qty, rate: l.rate }; });
        setEntries(next);
      })
      .catch(() => setEntries({}));
  }, [dateStr]);

  // Roll-ups.
  const catTotals = useMemo(() => {
    const t = {};
    items.forEach((it) => {
      const e = entries[it.id];
      const amt = num(e?.qty) * num(e?.rate);
      if (amt > 0) t[it.category_key] = (t[it.category_key] || 0) + amt;
    });
    return t;
  }, [entries, items]);
  const dayTotal = useMemo(
    () => Object.values(catTotals).reduce((s, v) => s + v, 0),
    [catTotals],
  );

  const groupedItems = useMemo(() => {
    const m = new Map(cats.map((c) => [c.key, { cat: c, rows: [] }]));
    items.forEach((it) => m.get(it.category_key)?.rows.push(it));
    return Array.from(m.values()).filter((g) => g.rows.length > 0);
  }, [items, cats]);

  const updateEntry = (itemId, field, value) => {
    setEntries((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [field]: value } }));
  };

  const save = async () => {
    const lines = items
      .map((it) => {
        const e = entries[it.id];
        const qty = num(e?.qty);
        const rate = num(e?.rate);
        if (qty <= 0) return null;
        return { item_id: it.id, qty, rate };
      })
      .filter(Boolean);
    setSaving(true);
    try {
      await api.put(`/meals/purchases/${dateStr}`, { lines });
      toast.success(`Purchases saved for ${formatDate(dateStr)}`);
      loadRecent();
    } catch (err) {
      showApiError(err, "Couldn't save purchases");
    } finally { setSaving(false); }
  };

  const onUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const res = await uploadFile("/meals/purchases/bulk-upload", file);
      setUploadResult(res);
      toast.success(`Imported ${res.imported_days} day(s) of purchases`);
      loadRecent();
    } catch (err) {
      showApiError(err, "Upload failed");
    } finally { setUploading(false); }
  };

  const downloadTemplate = () => {
    const head = ["Date", ...cats.map((c) => c.label)].join(",");
    const sample = [todayISO(), ...cats.map(() => "")].join(",");
    const blob = new Blob([`${head}\n${sample}\n`], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "purchases_template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div data-testid="meal-purchases-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input type="date" value={dateStr} max={todayISO()} onChange={(e) => setDateStr(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="purchase-date" />
        <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
        <span className="ml-auto flex items-center gap-2 flex-wrap">
          {isAdmin && (
            <>
              <button onClick={() => setShowItemsModal(true)} className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="purchase-manage-items">
                <Boxes size={14} /> Items
              </button>
              <button onClick={() => setShowCatModal(true)} className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="purchase-manage-cats">
                <Settings2 size={14} /> Categories
              </button>
            </>
          )}
        </span>
      </div>

      {groupedItems.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="purchase-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold text-slate-700">No items configured yet.</p>
          <p className="text-sm text-slate-500 mt-1">
            {isAdmin ? "Click Items above to add Rice, Oil, etc. under each category."
              : "Ask an admin to set up the item master."}
          </p>
        </div>
      ) : (
        <div className="iu-card overflow-hidden" data-testid="purchase-entry-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="text-left p-2 w-1/3">Item</th>
                <th className="text-right p-2 w-24">Qty</th>
                <th className="text-left p-2 w-16">Unit</th>
                <th className="text-right p-2 w-28">Rate ₹</th>
                <th className="text-right p-2 w-28">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {groupedItems.map(({ cat, rows }) => (
                <React.Fragment key={cat.key}>
                  <tr className="bg-slate-100/60"><td colSpan={5} className="px-2 py-1 text-[11px] font-bold text-slate-600 uppercase tracking-wider">{cat.label}</td></tr>
                  {rows.map((it) => {
                    const e = entries[it.id] || {};
                    const amt = num(e.qty) * num(e.rate);
                    return (
                      <tr key={it.id} className="border-t border-slate-100" data-testid={`purchase-row-${it.id}`}>
                        <td className="p-2 font-semibold text-slate-900">{it.name}</td>
                        <td className="p-2">
                          <input type="number" min="0" step="0.01" value={e.qty ?? ""} onChange={(ev) => updateEntry(it.id, "qty", ev.target.value)} className="iu-input !h-8 text-sm w-full text-right tabular-nums" placeholder="0" data-testid={`purchase-qty-${it.id}`} />
                        </td>
                        <td className="p-2 text-slate-500 text-xs">{it.unit}</td>
                        <td className="p-2">
                          <input type="number" min="0" step="0.01" value={e.rate ?? ""} onChange={(ev) => updateEntry(it.id, "rate", ev.target.value)} className="iu-input !h-8 text-sm w-full text-right tabular-nums" placeholder="0" data-testid={`purchase-rate-${it.id}`} />
                        </td>
                        <td className="p-2 text-right font-bold tabular-nums" data-testid={`purchase-amount-${it.id}`}>{amt > 0 ? `₹${inr(amt)}` : ""}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t border-slate-100 bg-slate-50/40">
                    <td colSpan={4} className="p-2 text-right text-xs text-slate-500">Subtotal · {cat.label}</td>
                    <td className="p-2 text-right font-bold tabular-nums" data-testid={`purchase-cat-total-${cat.key}`}>
                      {catTotals[cat.key] ? `₹${inr(catTotals[cat.key])}` : "—"}
                    </td>
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 border-t-2 border-slate-200">
              <tr>
                <td colSpan={4} className="p-3 text-right font-bold">Day total</td>
                <td className="p-3 text-right text-lg font-extrabold tabular-nums" data-testid="purchase-day-total">₹{inr(dayTotal)}</td>
              </tr>
            </tfoot>
          </table>
          <div className="p-3 border-t border-slate-100 flex justify-end">
            <button onClick={save} disabled={saving} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="purchase-save">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
          </div>
        </div>
      )}

      {/* Bulk upload (legacy category-total path preserved) */}
      <div className="iu-card p-4 mt-4" data-testid="purchase-upload-card">
        <h3 className="font-bold text-slate-900 mb-2">Bulk upload category totals from spreadsheet</h3>
        <p className="text-xs text-slate-500 mb-3">
          Legacy import: date + one column per category (Grocery, Vegetables, …). Item-level detail can only be
          entered above. Existing dates are updated, not duplicated.
        </p>
        <div className="flex gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={onUpload} data-testid="purchase-file-input" />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="purchase-upload-btn">
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload file
          </button>
          <button onClick={downloadTemplate} className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="purchase-template-btn">
            <FileDown size={14} /> CSV template
          </button>
        </div>
        {uploadResult && (
          <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1" data-testid="purchase-upload-result">
            <div><b>{uploadResult.imported_days}</b> day(s) imported</div>
            {uploadResult.errors?.length > 0 && (
              <ul className="text-rose-600 list-disc pl-4">{uploadResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            )}
          </div>
        )}
      </div>

      {/* Recent entries */}
      <div className="iu-card mt-4 overflow-auto" data-testid="purchase-recent">
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-sm">Last 30 days of entries</div>
        {recent.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500" data-testid="purchase-recent-empty">No purchase entries yet.</div>
        ) : (
          <table className="w-full text-xs min-w-[560px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((p) => {
                const totFromLines = (p.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
                const totFromAmounts = Object.values(p.amounts || {}).reduce((s, v) => s + (Number(v) || 0), 0);
                const tot = totFromLines || totFromAmounts;
                return (
                  <tr key={p.date} className="border-t border-slate-100 hover:bg-slate-50/70 cursor-pointer"
                      onClick={() => setDateStr(p.date)} title="Click to edit this day"
                      data-testid={`purchase-recent-row-${p.date}`}>
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{formatDate(p.date)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{(p.lines || []).length || "—"}</td>
                    <td className="px-3 py-1.5 text-right font-bold tabular-nums">₹{inr(tot)}</td>
                    <td className="px-3 py-1.5 text-slate-500 truncate max-w-[120px]">{p.updated_by_name || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showCatModal && <CategoryManagerModal categories={cats} onClose={() => setShowCatModal(false)} onSaved={(c) => { setCats(c); loadMasters(); }} />}
      {showItemsModal && <ItemManagerModal categories={cats} onClose={() => setShowItemsModal(false)} onChanged={loadMasters} />}
    </div>
  );
}
