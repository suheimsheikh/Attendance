/**
 * MealStockTab — stock-on-hand snapshot per item, as of a chosen date.
 * on_hand = opening_stock + Σ purchases (from opening_as_of) − Σ issues.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Boxes, AlertTriangle } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

export default function MealStockTab() {
  const [asOf, setAsOf] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showLowOnly, setShowLowOnly] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/stock?as_of=${asOf}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load stock"))
      .finally(() => setLoading(false));
  }, [asOf]);

  const rows = data?.rows || [];
  const cats = data?.categories || [];
  const grouped = useMemo(() => {
    const m = new Map(cats.map((c) => [c.key, { cat: c, rows: [] }]));
    rows.forEach((r) => {
      if (showLowOnly && r.on_hand > 0.001) return;
      if (!m.has(r.category_key)) m.set(r.category_key, { cat: { key: r.category_key, label: r.category_label }, rows: [] });
      m.get(r.category_key).rows.push(r);
    });
    return Array.from(m.values()).filter((g) => g.rows.length > 0);
  }, [rows, cats, showLowOnly]);

  const lowCount = rows.filter((r) => r.on_hand <= 0.001).length;

  return (
    <div data-testid="meal-stock-tab">
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input type="date" value={asOf} max={todayISO()} onChange={(e) => setAsOf(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="stock-as-of" />
        <span className="text-xs text-slate-500">{formatDate(asOf)}</span>
        <label className="ml-auto inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
          <input type="checkbox" checked={showLowOnly} onChange={(e) => setShowLowOnly(e.target.checked)} data-testid="stock-low-toggle" />
          Show low-stock only ({lowCount})
        </label>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : grouped.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="stock-empty">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold text-slate-700">
            {showLowOnly ? "Nothing low on stock." : "No items to show."}
          </p>
        </div>
      ) : (
        <div className="iu-card overflow-auto" data-testid="stock-table-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="text-left p-2">Item</th>
                <th className="text-left p-2 w-16">Unit</th>
                <th className="text-right p-2">Opening</th>
                <th className="text-right p-2">Purchased</th>
                <th className="text-right p-2">Issued</th>
                <th className="text-right p-2">Wasted</th>
                <th className="text-right p-2 bg-slate-100">On-hand</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ cat, rows: grows }) => (
                <React.Fragment key={cat.key}>
                  <tr className="bg-slate-100/60">
                    <td colSpan={7} className="px-2 py-1 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                      {cat.label} <span className="text-slate-400">· {grows.length}</span>
                    </td>
                  </tr>
                  {grows.map((r) => {
                    const low = r.on_hand <= 0.001;
                    return (
                      <tr key={r.item_id} className={`border-t border-slate-100 ${low ? "bg-rose-50/40" : ""}`} data-testid={`stock-row-${r.item_id}`}>
                        <td className="p-2 font-semibold text-slate-900 flex items-center gap-2">
                          {r.name}
                          {low && <AlertTriangle size={13} className="text-rose-500" />}
                        </td>
                        <td className="p-2 text-slate-500 text-xs">{r.unit}</td>
                        <td className="p-2 text-right tabular-nums text-slate-600">{fmt(r.opening_stock)}</td>
                        <td className="p-2 text-right tabular-nums text-emerald-700">{r.purchased ? `+${fmt(r.purchased)}` : "0"}</td>
                        <td className="p-2 text-right tabular-nums text-rose-700">{r.issued ? `−${fmt(r.issued)}` : "0"}</td>
                        <td className="p-2 text-right tabular-nums text-amber-700" data-testid={`stock-wasted-${r.item_id}`}>{r.wasted ? `−${fmt(r.wasted)}` : "0"}</td>
                        <td className={`p-2 text-right tabular-nums font-bold bg-slate-50/70 ${low ? "text-rose-700" : "text-slate-900"}`} data-testid={`stock-onhand-${r.item_id}`}>
                          {fmt(r.on_hand)}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
