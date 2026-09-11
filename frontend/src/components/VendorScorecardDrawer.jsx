/**
 * VendorScorecardDrawer — right-side drawer showing a supplier's
 * 30-day performance at a glance (Feb 2026 user request).
 *
 * Opened when a chef clicks a vendor name anywhere in the app. Answers:
 *   • How much did we spend with them this month?
 *   • Which items are they charging above the market average?
 *   • Are their rates rising, and if so on what?
 *
 * Read-only — zero API cost beyond one GET, no writes.
 */
import React, { useEffect, useState } from "react";
import { X, TrendingUp, TrendingDown, Minus, Phone, Loader2, Store } from "lucide-react";
import { api, showApiError } from "../api";
import { fmtQty as uQty } from "../utils";

const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n, unit) =>
  n == null ? "—" : uQty(n, unit);

export default function VendorScorecardDrawer({ vendorId, days = 30, onClose, onOpenItem }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!vendorId) return;
    let ok = true;
    setLoading(true);
    api.get(`/meals/vendors/${vendorId}/scorecard`, { days })
      .then((r) => { if (ok) setData(r); })
      .catch((e) => showApiError(e, "Couldn't load scorecard"))
      .finally(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [vendorId, days]);

  if (!vendorId) return null;

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="vendor-scorecard-drawer">
      <button
        aria-label="Close scorecard"
        onClick={onClose}
        className="flex-1 bg-slate-900/40 backdrop-blur-[2px]"
        data-testid="vendor-scorecard-backdrop"
      />
      <div className="w-full max-w-2xl h-full bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200 px-5 py-3 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 flex items-center gap-1.5">
              <Store size={12}/> Vendor scorecard · last {data?.days || days} days
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 truncate" data-testid="vendor-scorecard-name">
              {data?.vendor?.name || "Vendor"}
            </h2>
            {data?.vendor?.phone && (
              <div className="mt-0.5 text-xs text-slate-600 inline-flex items-center gap-1">
                <Phone size={11}/> <a href={`tel:${data.vendor.phone}`} className="underline">{data.vendor.phone}</a>
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 shrink-0"
            title="Close"
            data-testid="vendor-scorecard-close"
          ><X size={18}/></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <Loader2 className="animate-spin" size={22}/>
          </div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">No data.</div>
        ) : (
          <div className="flex-1 p-5 space-y-5">
            {/* Headline KPI cards */}
            <div className="grid grid-cols-3 gap-3" data-testid="vendor-scorecard-kpis">
              <Kpi label="Total spend" value={`₹${inr(data.total_spend)}`} tone="emerald"/>
              <Kpi label="Line items" value={data.total_lines} tone="sky"/>
              <Kpi label="Items supplied" value={data.item_count} tone="violet"/>
            </div>

            {data.items.length === 0 ? (
              <div className="iu-card p-8 text-center text-slate-500 text-sm" data-testid="vendor-scorecard-empty">
                No purchases logged for this vendor in the last {data.days} days.
              </div>
            ) : (
              <div className="iu-card overflow-hidden" data-testid="vendor-scorecard-items">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider font-bold text-slate-500 flex items-center justify-between">
                  <span>Items · sorted by spend</span>
                  <span className="text-[10px] text-slate-400 font-medium normal-case">Click any row for full price history</span>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-50/50 border-b border-slate-100">
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2">Spend</th>
                      <th className="text-right px-2 py-2" title="Vendor's average rate over the window">Avg ₹</th>
                      <th className="text-right px-2 py-2" title="Vendor's latest rate">Latest ₹</th>
                      <th className="text-right px-2 py-2" title="Market average across ALL vendors for this item">Market ₹</th>
                      <th className="text-right pr-3 pl-2 py-2" title="Vendor rate vs market average. + = pricier than market">Vs mkt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((it) => (
                      <tr
                        key={it.item_id}
                        onClick={() => onOpenItem?.(it.item_id, it.name)}
                        className="border-t border-slate-100 hover:bg-emerald-50/40 cursor-pointer"
                        data-testid={`vendor-scorecard-row-${it.item_id}`}
                      >
                        <td className="px-3 py-2 font-semibold text-slate-900">
                          <div>{it.name}</div>
                          <div className="text-[10px] text-slate-400">
                            {it.line_count} purchase{it.line_count === 1 ? "" : "s"} · last {it.last_purchase_date || "—"}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                          {fmtQty(it.qty, it.unit)} <span className="text-[10px] text-slate-400">{it.unit}</span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums font-semibold text-emerald-700">
                          ₹{inr(it.spend)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                          {inr(it.avg_rate)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                          {inr(it.latest_rate)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-slate-500">
                          {inr(it.market_avg)}
                        </td>
                        <td className="pr-3 pl-2 py-2 text-right tabular-nums">
                          <VarianceBadge pct={it.variance_pct}/>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] text-slate-400 leading-relaxed">
              Prices compared with the market average across all suppliers for the same item.
              A green ▼ tag means this vendor is cheaper than the market; a red ▲ means pricier.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = "slate" }) {
  const map = {
    emerald: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    sky:     "bg-sky-50 text-sky-800 ring-sky-200",
    violet:  "bg-violet-50 text-violet-800 ring-violet-200",
    slate:   "bg-slate-50 text-slate-800 ring-slate-200",
  };
  return (
    <div className={`rounded-xl ring-1 ${map[tone]} p-3`}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-lg font-extrabold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function VarianceBadge({ pct }) {
  if (pct == null) {
    return <span className="text-[10px] text-slate-400 inline-flex items-center gap-0.5"><Minus size={10}/> n/a</span>;
  }
  if (Math.abs(pct) < 0.5) {
    return (
      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold rounded bg-slate-100 text-slate-600">
        <Minus size={10}/> {pct.toFixed(1)}%
      </span>
    );
  }
  const up = pct > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-bold rounded ${up ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
      {up ? <TrendingUp size={10}/> : <TrendingDown size={10}/>}
      {up ? "+" : ""}{pct.toFixed(1)}%
    </span>
  );
}
