import React, { useEffect, useState } from "react";
import { api, showApiError } from "../../api";
import { HeartPulse, Loader2, AlertTriangle, PackageX, TrendingDown, RefreshCw } from "lucide-react";

function Card({ icon: Icon, tint, label, value, hint }) {
  return (
    <div className={`iu-card p-4 flex items-center gap-3 ${tint}`}>
      <div className="w-10 h-10 rounded-lg bg-white/70 flex items-center justify-center shrink-0"><Icon size={18} /></div>
      <div>
        <div className="text-2xl font-black tabular-nums">{value}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-[11px] text-slate-500">{hint}</div>
      </div>
    </div>
  );
}

function ItemList({ title, items, note, testid }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="iu-card overflow-hidden" data-testid={testid}>
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
        <div className="font-bold text-sm text-slate-800">{title} <span className="text-slate-400 font-normal">({items.length})</span></div>
        {note && <div className="text-[11px] text-slate-500">{note}</div>}
      </div>
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase text-slate-400">
          <tr><th className="text-left p-2">Item</th><th className="text-left p-2">Category</th><th className="text-right p-2">On hand</th></tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.item_id} className="border-t border-slate-100">
              <td className="p-2 font-semibold text-slate-900">{it.name}</td>
              <td className="p-2 text-slate-500">{it.category}</td>
              <td className={`p-2 text-right tabular-nums font-bold ${(it.on_hand || 0) < 0 ? "text-rose-600" : "text-slate-700"}`}>{it.on_hand}{it.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MealsDataHealth() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get("/meals/data-health")
      .then(setData)
      .catch((e) => showApiError(e, "Couldn't load data health"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const c = data?.counts || {};
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto" data-testid="meals-data-health">
      <div className="flex items-center gap-2 mb-1">
        <HeartPulse size={20} className="text-slate-700" />
        <h1 className="text-xl font-black text-slate-900">Kitchen Data Health</h1>
        <button onClick={load} className="iu-btn-secondary !h-7 !px-2 text-xs ml-auto inline-flex items-center gap-1" data-testid="health-refresh"><RefreshCw size={12} /> Refresh</button>
      </div>
      <p className="text-xs text-slate-500 mb-4">Items that need attention so stock stays accurate and issuing never gets blocked.{data?.as_of ? ` As of ${data.as_of}.` : ""}</p>

      {loading ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
            <Card icon={AlertTriangle} tint="bg-rose-50" label="Negative stock" value={c.negative_stock ?? 0} hint="Issued/wasted more than received — fix the count" />
            <Card icon={PackageX} tint="bg-amber-50" label="No stock tracked" value={c.no_stock_untracked ?? 0} hint="No opening & no purchase — issuing is blocked" />
            <Card icon={TrendingDown} tint="bg-sky-50" label="Low stock" value={c.low_stock ?? 0} hint="At or below the item's minimum level" />
          </div>

          {(c.negative_stock || 0) + (c.no_stock_untracked || 0) === 0 && (
            <div className="iu-card p-6 text-center text-emerald-700 bg-emerald-50 mb-4" data-testid="health-all-good">
              ✓ No blocking issues — every item can be issued.
            </div>
          )}

          <div className="space-y-4">
            <ItemList testid="health-negative" title="Negative stock" note="Record a purchase or correct the physical count in Stock Take." items={data.negative_stock} />
            <ItemList testid="health-untracked" title="No stock tracked" note="Enter opening stock (Stock Master → item → Opening stock) or record a purchase before issuing." items={data.no_stock_untracked} />
            <ItemList testid="health-low" title="Low stock" note="Below the minimum level — consider restocking." items={data.low_stock} />
          </div>
        </>
      )}
    </div>
  );
}
