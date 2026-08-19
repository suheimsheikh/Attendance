import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Save, X, Store, Phone, TrendingUp } from "lucide-react";
import { api, showApiError } from "../../api";

const inr = (n) =>
  n == null ? "0" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });

/**
 * Sparkline — tiny inline SVG showing a vendor's monthly spend trend
 * so admins can spot a supplier who is quietly getting expensive.
 * Baseline is the max value in the series; a flat line is drawn when
 * every month is zero. The last point is dotted brighter to draw the
 * eye. Aug 2026 user request.
 */
function Sparkline({ series }) {
  if (!series || series.length === 0) {
    return <span className="text-slate-400 text-[10px]">no data</span>;
  }
  const width = 96, height = 24;
  const values = series.map((s) => Number(s.amount) || 0);
  const max = Math.max(1, ...values);
  const stepX = width / Math.max(1, series.length - 1);
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1].split(",");
  const total = values.reduce((s, v) => s + v, 0);
  const firstNonZero = values.find((v) => v > 0) || 0;
  const trendUp = values.length >= 2 && values[values.length - 1] > firstNonZero;
  const stroke = total === 0 ? "#94a3b8" : trendUp ? "#dc2626" : "#059669";
  const fill   = total === 0 ? "transparent" : trendUp ? "#fecaca55" : "#bbf7d055";
  return (
    <span className="inline-flex items-center gap-1.5" title={series.map((s) => `${s.ym}: ₹${inr(s.amount)}`).join("\n")}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
        <polyline
          fill={fill}
          stroke={stroke}
          strokeWidth="1.5"
          points={`0,${height} ${points.join(" ")} ${width},${height}`}
        />
        <polyline
          fill="none"
          stroke={stroke}
          strokeWidth="1.5"
          points={points.join(" ")}
        />
        <circle cx={last[0]} cy={last[1]} r="2.5" fill={stroke} />
      </svg>
      <span className="text-[10px] font-semibold tabular-nums text-slate-500">
        ₹{inr(total)}
      </span>
    </span>
  );
}

/**
 * MealVendorsTab — Vendors master (Aug 2026 user request).
 * Light supplier registry (just name + phone) that feeds the vendor
 * dropdown on the Daily-entry purchases grid. Deletion is soft when
 * the vendor is already referenced on a purchase line so historical
 * bills keep their supplier context; unused vendors are hard-deleted
 * to keep the master tidy.
 */
export default function MealVendorsTab({ liveSig }) {
  const [rows, setRows] = useState([]);
  const [trends, setTrends] = useState({}); // vendor_id → { series, total }
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", phone: "" });
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ name: "", phone: "" });

  const refresh = () => {
    setLoading(true);
    Promise.all([
      api.get("/meals/vendors"),
      api.get("/meals/vendor-trends", { months: 6 }),
    ])
      .then(([listRes, trendRes]) => {
        setRows(listRes.vendors || []);
        const map = {};
        for (const v of trendRes.vendors || []) {
          map[v.id] = { series: v.series, total: v.total };
        }
        setTrends(map);
      })
      .catch(showApiError)
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  // Live refresh — skipped while a row editor or the add form is open
  // so another machine's change never wipes an in-progress edit.
  useEffect(() => {
    if (!liveSig || editingId || adding) return;
    refresh();
  }, [liveSig]);

  const submitCreate = async () => {
    const name = draft.name.trim();
    if (!name) { toast.error("Name required"); return; }
    try {
      await api.post("/meals/vendors", { name, phone: draft.phone.trim() || null });
      toast.success(`Added ${name}`);
      setDraft({ name: "", phone: "" });
      setAdding(false);
      refresh();
    } catch (e) { showApiError(e); }
  };

  const startEdit = (v) => {
    setEditingId(v.id);
    setEdit({ name: v.name, phone: v.phone || "" });
  };
  const saveEdit = async () => {
    if (!edit.name.trim()) { toast.error("Name required"); return; }
    try {
      await api.patch(`/meals/vendors/${editingId}`, { name: edit.name.trim(), phone: edit.phone.trim() || null });
      toast.success("Saved");
      setEditingId(null);
      refresh();
    } catch (e) { showApiError(e); }
  };

  const remove = async (v) => {
    if (!window.confirm(`Delete vendor "${v.name}"?`)) return;
    try {
      const r = await api.delete(`/meals/vendors/${v.id}`);
      toast.success(r.soft_deleted ? "Deactivated (used in past purchases)" : "Deleted");
      refresh();
    } catch (e) { showApiError(e); }
  };

  return (
    <div data-testid="meal-vendors-tab" className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900 inline-flex items-center gap-2">
            <Store size={18} className="text-emerald-600"/> Vendors master
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Suppliers you can attribute purchase lines to. Vendor selection on the
            Daily entry grid is optional but strongly encouraged.
          </p>
        </div>
        {!adding && (
          <button
            className="iu-btn-primary !h-9"
            onClick={() => setAdding(true)}
            data-testid="vendor-add-btn"
          ><Plus size={14}/> Add vendor</button>
        )}
      </div>

      {adding && (
        <div className="iu-card p-3 mb-4 flex items-end gap-2 flex-wrap" data-testid="vendor-add-form">
          <label className="text-xs font-semibold text-slate-600 flex-1 min-w-[180px]">
            <div className="mb-1">Name</div>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Reliance Fresh"
              className="iu-input !h-9 !w-full text-sm"
              data-testid="vendor-add-name"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600 flex-1 min-w-[160px]">
            <div className="mb-1">Phone</div>
            <input
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="Optional"
              className="iu-input !h-9 !w-full text-sm"
              data-testid="vendor-add-phone"
            />
          </label>
          <button className="iu-btn-primary !h-9" onClick={submitCreate} data-testid="vendor-add-save">
            <Save size={14}/> Save
          </button>
          <button
            className="iu-btn-secondary !h-9"
            onClick={() => { setAdding(false); setDraft({ name: "", phone: "" }); }}
            data-testid="vendor-add-cancel"
          ><X size={14}/> Cancel</button>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500" data-testid="vendor-empty">
          <Store size={30} className="mx-auto text-slate-300 mb-2"/>
          No vendors yet. Add one to start attributing purchases.
        </div>
      ) : (
        <div className="iu-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="text-left p-2.5">Name</th>
                <th className="text-left p-2.5 hidden sm:table-cell">Phone</th>
                <th className="text-left p-2.5 hidden md:table-cell" title="Monthly spend, last 6 months">
                  <span className="inline-flex items-center gap-1"><TrendingUp size={12}/> 6-mo trend</span>
                </th>
                <th className="w-32"/>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const isEditing = editingId === v.id;
                const trend = trends[v.id];
                return (
                  <tr key={v.id} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`vendor-row-${v.id}`}>
                    <td className="p-2.5 font-semibold text-slate-900">
                      {isEditing ? (
                        <input
                          value={edit.name}
                          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                          className="iu-input !h-8 text-sm w-full"
                          data-testid={`vendor-edit-name-${v.id}`}
                        />
                      ) : v.name}
                    </td>
                    <td className="p-2.5 text-slate-600 hidden sm:table-cell">
                      {isEditing ? (
                        <input
                          value={edit.phone}
                          onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                          className="iu-input !h-8 text-sm w-full"
                          data-testid={`vendor-edit-phone-${v.id}`}
                        />
                      ) : (v.phone
                        ? <span className="inline-flex items-center gap-1"><Phone size={12}/> {v.phone}</span>
                        : <span className="text-slate-400">—</span>)}
                    </td>
                    <td className="p-2.5 hidden md:table-cell" data-testid={`vendor-trend-${v.id}`}>
                      <Sparkline series={trend?.series} />
                    </td>
                    <td className="p-2.5 text-right">
                      {isEditing ? (
                        <div className="inline-flex gap-1">
                          <button className="iu-btn-primary !h-8 !px-2" onClick={saveEdit} data-testid={`vendor-save-${v.id}`}>
                            <Save size={12}/>
                          </button>
                          <button className="iu-btn-secondary !h-8 !px-2" onClick={() => setEditingId(null)} data-testid={`vendor-cancel-${v.id}`}>
                            <X size={12}/>
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex gap-1">
                          <button
                            className="iu-btn-secondary !h-8 !px-2 !text-slate-600"
                            onClick={() => startEdit(v)}
                            title="Edit"
                            data-testid={`vendor-edit-${v.id}`}
                          ><Pencil size={12}/></button>
                          <button
                            className="iu-btn-secondary !h-8 !px-2 !text-rose-600 !border-rose-200 hover:!bg-rose-50"
                            onClick={() => remove(v)}
                            title="Delete"
                            data-testid={`vendor-delete-${v.id}`}
                          ><Trash2 size={12}/></button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
