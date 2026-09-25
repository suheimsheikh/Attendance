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
  Loader2, Save, Upload, FileDown, Boxes, AlertTriangle, X as CloseIcon,
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
  n == null ? "0.00" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);

// ---------------------------------------------------------------------------
// Purchases tab
// ---------------------------------------------------------------------------
export default function MealPurchasesTab({ onGoMasters, liveSig }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [dateStr, setDateStr] = useState(todayISO());
  const [entries, setEntries] = useState({});       // { item_id: {qty, rate} }
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const [lastRates, setLastRates] = useState({});   // { item_id: {rate, date} }
  const [outlierConfirm, setOutlierConfirm] = useState(null); // list of outliers or null
  const OUTLIER_PCT = 5; // warn if new rate deviates >5% from the previous purchase rate
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
  // Live-refresh on SSE (Feb 2026): another chef added/edited a vendor,
  // item or category — reload the master lookup lists so this tab sees
  // the change within ~1 second instead of on the next tab-switch.
  useEffect(() => {
    if (!liveSig) return;
    if (["vendors", "items", "categories"].includes(liveSig.scope)) loadMasters();
  }, [liveSig]);

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
    // Baseline for the outlier warning = each item's most-recent purchase
    // rate STRICTLY BEFORE the date being entered.
    api.get(`/meals/items/last-rates?before=${dateStr}`)
      .then((r) => setLastRates(r.rates || {}))
      .catch(() => setLastRates({}));
  }, [dateStr]);

  // Per-item price-outlier check: returns {prev, pct} when the entered
  // rate deviates more than OUTLIER_PCT% from the previous purchase rate,
  // else null (no previous rate, no entry, or within tolerance).
  const outlierFor = (itemId) => {
    const e = entries[itemId];
    const rate = num(e?.rate);
    if (rate <= 0) return null;
    const prev = lastRates[itemId]?.rate;
    if (!prev || prev <= 0) return null;
    const pct = ((rate - prev) / prev) * 100;
    return Math.abs(pct) > OUTLIER_PCT ? { prev, pct, date: lastRates[itemId]?.date } : null;
  };

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

  const doSave = async () => {
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
      // Refresh baselines so subsequent edits compare against the new rates.
      api.get(`/meals/items/last-rates?before=${dateStr}`)
        .then((r) => setLastRates(r.rates || {}))
        .catch(() => {});
    } catch (err) {
      showApiError(err, "Couldn't save purchases");
    } finally { setSaving(false); }
  };

  const save = () => {
    // Collect any rate outliers (>±5% vs the previous purchase rate) and
    // ask the user to confirm before accepting them.
    const outliers = items
      .map((it) => {
        const o = outlierFor(it.id);
        if (!o) return null;
        return { id: it.id, name: it.name, unit: it.unit, rate: num(entries[it.id]?.rate), ...o };
      })
      .filter(Boolean);
    if (outliers.length > 0) {
      setOutlierConfirm(outliers);
      return;
    }
    doSave();
  };

  const confirmOutliers = () => {
    setOutlierConfirm(null);
    doSave();
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
          {isAdmin && onGoMasters && (
            <button onClick={onGoMasters} className="iu-btn-secondary !h-9 !px-3 text-sm" title="Items and categories are managed in the Masters tree" data-testid="purchase-go-masters">
              <Boxes size={14} /> Manage in Masters
            </button>
          )}
        </span>
      </div>

      {groupedItems.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="purchase-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold text-slate-700">No items configured yet.</p>
          <p className="text-sm text-slate-500 mt-1">
            {isAdmin ? "Open the Masters tab to add Rice, Oil, etc. under each category."
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
                    const ol = outlierFor(it.id);
                    return (
                      <tr key={it.id} className="border-t border-slate-100" data-testid={`purchase-row-${it.id}`}>
                        <td className="p-2 font-semibold text-slate-900">{it.name}</td>
                        <td className="p-2">
                          <input type="number" min="0" step="0.01" value={e.qty ?? ""} onChange={(ev) => updateEntry(it.id, "qty", ev.target.value)} className="iu-input !h-8 text-sm w-full text-right tabular-nums" placeholder="0" data-testid={`purchase-qty-${it.id}`} />
                        </td>
                        <td className="p-2 text-slate-500 text-xs">{it.unit}</td>
                        <td className="p-2">
                          <div className="flex items-center justify-end gap-1">
                            {ol && (
                              <span
                                className={`shrink-0 ${ol.pct > 0 ? "text-rose-500" : "text-amber-500"}`}
                                title={`Unusual price: ${ol.pct > 0 ? "+" : ""}${ol.pct.toFixed(1)}% vs previous ₹${inr(ol.prev)}${ol.date ? ` (on ${formatDate(ol.date)})` : ""}`}
                                data-testid={`purchase-outlier-${it.id}`}
                              >
                                <AlertTriangle size={14} />
                              </span>
                            )}
                            <input type="number" min="0" step="0.01" value={e.rate ?? ""} onChange={(ev) => updateEntry(it.id, "rate", ev.target.value)} className={`iu-input !h-8 text-sm w-full text-right tabular-nums ${ol ? "!ring-2 !ring-amber-300 !border-amber-300" : ""}`} placeholder="0" data-testid={`purchase-rate-${it.id}`} />
                          </div>
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

      {/* Price-outlier confirmation (Jun 2026) — warns when an entered rate
          deviates more than ±5% from the item's previous purchase rate. */}
      {outlierConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4"
             onClick={(e) => { if (e.target === e.currentTarget) setOutlierConfirm(null); }}
             data-testid="purchase-outlier-modal">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-slate-100 bg-amber-50">
              <AlertTriangle size={18} className="text-amber-600" />
              <h3 className="font-black text-slate-900">Unusual prices detected</h3>
              <button type="button" onClick={() => setOutlierConfirm(null)}
                      className="ml-auto p-1 rounded-md text-slate-400 hover:bg-slate-100"
                      data-testid="purchase-outlier-close" aria-label="Close">
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-slate-600 mb-3">
                {outlierConfirm.length === 1 ? "1 item is" : `${outlierConfirm.length} items are`} priced more than {OUTLIER_PCT}% away from the last purchase. Please double-check before saving.
              </p>
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="text-left p-2">Item</th>
                      <th className="text-right p-2">Previous ₹</th>
                      <th className="text-right p-2">New ₹</th>
                      <th className="text-right p-2">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outlierConfirm.map((o) => (
                      <tr key={o.id} className="border-t border-slate-100" data-testid={`purchase-outlier-row-${o.id}`}>
                        <td className="p-2 font-semibold text-slate-900">{o.name}<span className="text-slate-400 font-normal"> /{o.unit}</span></td>
                        <td className="p-2 text-right tabular-nums text-slate-500">₹{inr(o.prev)}</td>
                        <td className="p-2 text-right tabular-nums font-bold text-slate-900">₹{inr(o.rate)}</td>
                        <td className={`p-2 text-right tabular-nums font-black ${o.pct > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                          {o.pct > 0 ? "+" : ""}{o.pct.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2">
              <button type="button" onClick={() => setOutlierConfirm(null)}
                      className="iu-btn-secondary !h-9 !px-4 text-sm" data-testid="purchase-outlier-cancel">
                Go back &amp; fix
              </button>
              <button type="button" onClick={confirmOutliers}
                      className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="purchase-outlier-confirm">
                Save anyway
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
