/**
 * MealPurchasesTab — daily purchase entry + spreadsheet bulk upload +
 * (admin-only) purchase-category manager. Admin + chef access.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save, Upload, Settings2, Plus, Trash2, X, FileDown } from "lucide-react";
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
                title="Remove"
                data-testid={`purchase-cat-remove-${i}`}
              ><Trash2 size={15} /></button>
            </div>
          ))}
          <button
            onClick={() => setRows([...rows, { key: null, label: "" }])}
            className="iu-btn-secondary !h-9 !px-3 text-sm w-full"
            data-testid="purchase-cat-add"
          ><Plus size={14} /> Add category</button>
          <p className="text-[11px] text-slate-400">
            Removing a category hides its column for new entries; historic amounts still count in report totals.
          </p>
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

export default function MealPurchasesTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [cats, setCats] = useState([]);
  const [dateStr, setDateStr] = useState(todayISO());
  const [amounts, setAmounts] = useState({});
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);
  const [showCatModal, setShowCatModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    api.get("/meals/purchase-categories")
      .then((r) => setCats(r.categories || []))
      .catch((err) => showApiError(err, "Couldn't load categories"));
  }, []);

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

  // Load existing amounts whenever the date changes.
  useEffect(() => {
    api.get(`/meals/purchases?start=${dateStr}&end=${dateStr}`)
      .then((r) => setAmounts((r.purchases?.[0]?.amounts) || {}))
      .catch(() => setAmounts({}));
  }, [dateStr]);

  const dayTotal = useMemo(
    () => Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0),
    [amounts],
  );

  const save = async () => {
    setSaving(true);
    try {
      await api.put(`/meals/purchases/${dateStr}`, { amounts });
      toast.success(`Purchases saved for ${formatDate(dateStr)}`);
      loadRecent();
    } catch (err) {
      showApiError(err, "Couldn't save purchases");
    } finally {
      setSaving(false);
    }
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
      // Refresh the current date's amounts in case it was in the file.
      const r = await api.get(`/meals/purchases?start=${dateStr}&end=${dateStr}`);
      setAmounts((r.purchases?.[0]?.amounts) || {});
    } catch (err) {
      showApiError(err, "Upload failed");
    } finally {
      setUploading(false);
    }
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Daily entry ─────────────────────────────────────── */}
        <div className="iu-card p-4" data-testid="purchase-entry-card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-slate-900">Daily purchase entry</h3>
            {isAdmin && (
              <button onClick={() => setShowCatModal(true)} className="iu-btn-secondary !h-8 !px-2.5 text-xs" data-testid="purchase-manage-cats">
                <Settings2 size={13} /> Categories
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 mb-3">
            <input
              type="date" value={dateStr} max={todayISO()}
              onChange={(e) => setDateStr(e.target.value)}
              className="iu-input !h-9 !w-auto text-sm"
              data-testid="purchase-date"
            />
            <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
          </div>
          <div className="space-y-2">
            {cats.map((c) => (
              <div key={c.key} className="flex items-center gap-3">
                <label className="text-sm font-semibold text-slate-700 w-40 shrink-0">{c.label}</label>
                <div className="relative flex-1">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">₹</span>
                  <input
                    type="number" min="0" step="0.01"
                    value={amounts[c.key] ?? ""}
                    onChange={(e) => setAmounts({ ...amounts, [c.key]: e.target.value })}
                    className="iu-input !h-9 !pl-7 text-sm w-full"
                    placeholder="0"
                    data-testid={`purchase-amount-${c.key}`}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100">
            <div className="text-sm">
              Day total: <b className="tabular-nums" data-testid="purchase-day-total">₹{inr(dayTotal)}</b>
            </div>
            <button onClick={save} disabled={saving} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="purchase-save">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
          </div>
        </div>

        {/* ── Bulk upload ─────────────────────────────────────── */}
        <div className="iu-card p-4" data-testid="purchase-upload-card">
          <h3 className="font-bold text-slate-900 mb-2">Bulk upload from spreadsheet</h3>
          <p className="text-xs text-slate-500 mb-3">
            CSV or Excel (.xlsx). First column = <b>Date</b> (e.g. 1/7/2026 or 2026-07-01), other columns matched to
            your categories by name — commas in amounts are fine. Existing dates are updated, not duplicated.
          </p>
          <div className="flex gap-2 flex-wrap">
            <input ref={fileRef} type="file" accept=".csv,.xlsx" className="hidden" onChange={onUpload} data-testid="purchase-file-input" />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="iu-btn-primary !h-9 !px-4 text-sm"
              data-testid="purchase-upload-btn"
            >
              {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload file
            </button>
            <button onClick={downloadTemplate} className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="purchase-template-btn">
              <FileDown size={14} /> CSV template
            </button>
          </div>
          {uploadResult && (
            <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1" data-testid="purchase-upload-result">
              <div><b>{uploadResult.imported_days}</b> day(s) imported
                {uploadResult.dates?.length > 0 && (
                  <span className="text-slate-500"> ({uploadResult.dates[0]} → {uploadResult.dates[uploadResult.dates.length - 1]})</span>
                )}
              </div>
              {uploadResult.matched_columns?.length > 0 && (
                <div className="text-slate-600">Matched columns: {uploadResult.matched_columns.join(", ")}</div>
              )}
              {uploadResult.unmatched_columns?.length > 0 && (
                <div className="text-amber-700">Ignored columns: {uploadResult.unmatched_columns.join(", ")}</div>
              )}
              {uploadResult.skipped_rows > 0 && (
                <div className="text-slate-500">{uploadResult.skipped_rows} row(s) skipped (blank / totals rows)</div>
              )}
              {uploadResult.errors?.length > 0 && (
                <ul className="text-rose-600 list-disc pl-4">
                  {uploadResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Recent entries ──────────────────────────────────── */}
      <div className="iu-card mt-4 overflow-auto" data-testid="purchase-recent">
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-sm">Last 30 days of entries</div>
        {recent.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500" data-testid="purchase-recent-empty">No purchase entries yet.</div>
        ) : (
          <table className="w-full text-xs min-w-[560px]">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                {cats.map((c) => <th key={c.key} className="px-2 py-2 text-right">{c.label}</th>)}
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((p) => {
                const tot = Object.values(p.amounts || {}).reduce((s, v) => s + (Number(v) || 0), 0);
                return (
                  <tr
                    key={p.date}
                    className="border-t border-slate-100 hover:bg-slate-50/70 cursor-pointer"
                    onClick={() => setDateStr(p.date)}
                    title="Click to edit this day"
                    data-testid={`purchase-recent-row-${p.date}`}
                  >
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{formatDate(p.date)}</td>
                    {cats.map((c) => (
                      <td key={c.key} className={`px-2 py-1.5 text-right tabular-nums ${p.amounts?.[c.key] ? "" : "text-slate-300"}`}>
                        {inr(p.amounts?.[c.key] || 0)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5 text-right font-bold tabular-nums">₹{inr(tot)}</td>
                    <td className="px-3 py-1.5 text-slate-500 truncate max-w-[120px]">{p.updated_by_name || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showCatModal && (
        <CategoryManagerModal
          categories={cats}
          onClose={() => setShowCatModal(false)}
          onSaved={setCats}
        />
      )}
    </div>
  );
}
