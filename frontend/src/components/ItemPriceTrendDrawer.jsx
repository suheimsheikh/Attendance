/**
 * ItemPriceTrendDrawer — full price history chart for one pantry item
 * (Feb 2026 user request: "double-click any item → graph showing
 * quantities purchased & price graph from the beginning").
 *
 * Chart: composed line + bar. Left Y = rate (₹/unit) line; right Y =
 * qty bars. X = date. Points hydrate a table below the chart for
 * accountants who want the receipts.
 */
import React, { useEffect, useState } from "react";
import { X, Loader2, TrendingUp, BarChart2 } from "lucide-react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { api, showApiError } from "../api";
import { fmtQty as uQty } from "../utils";

const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n, unit) =>
  n == null ? "—" : uQty(n, unit);

export default function ItemPriceTrendDrawer({ itemId, itemName, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!itemId) return;
    let ok = true;
    setLoading(true);
    api.get(`/meals/items/${itemId}/price-trend`)
      .then((r) => { if (ok) setData(r); })
      .catch((e) => showApiError(e, "Couldn't load price trend"))
      .finally(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [itemId]);

  if (!itemId) return null;
  const points = data?.points || [];
  const s = data?.summary;

  return (
    <div className="fixed inset-0 z-[60] flex" data-testid="item-price-trend-drawer">
      <button
        aria-label="Close price trend"
        onClick={onClose}
        className="flex-1 bg-slate-900/40 backdrop-blur-[2px]"
        data-testid="item-price-trend-backdrop"
      />
      <div className="w-full max-w-3xl h-full bg-white shadow-2xl overflow-y-auto flex flex-col">
        <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-200 px-5 py-3 flex items-start justify-between gap-3 z-10">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider font-bold text-sky-700 flex items-center gap-1.5">
              <TrendingUp size={12}/> Price trend
            </div>
            <h2 className="text-xl font-extrabold text-slate-900 truncate" data-testid="item-price-trend-name">
              {data?.item?.name || itemName || "Item"}
            </h2>
            {s?.first_date && (
              <div className="text-[11px] text-slate-500 mt-0.5">
                {s.first_date} → {s.last_date} · {s.point_count} purchase{s.point_count === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100 shrink-0"
            title="Close"
            data-testid="item-price-trend-close"
          ><X size={18}/></button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            <Loader2 className="animate-spin" size={22}/>
          </div>
        ) : !data || points.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-slate-500 text-sm" data-testid="item-price-trend-empty">
            <div className="text-center">
              <BarChart2 className="mx-auto text-slate-300 mb-3" size={40}/>
              No purchase history recorded for this item yet.
            </div>
          </div>
        ) : (
          <div className="flex-1 p-5 space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="item-price-trend-kpis">
              <Kpi label="Latest ₹/unit" value={`₹${inr(s.latest_rate)}`} tone="sky"/>
              <Kpi label="Avg ₹/unit"    value={`₹${inr(s.avg_rate)}`}    tone="emerald"/>
              <Kpi label="Lowest ₹"      value={`₹${inr(s.min_rate)}`}    tone="violet"/>
              <Kpi label="Highest ₹"     value={`₹${inr(s.max_rate)}`}    tone="rose"/>
            </div>

            <div className="iu-card p-3">
              <div className="h-72 w-full">
                <ResponsiveContainer>
                  <ComposedChart
                    data={points}
                    margin={{ top: 10, right: 12, left: 0, bottom: 5 }}
                  >
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3"/>
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: "#64748b" }}
                      minTickGap={20}
                    />
                    <YAxis
                      yAxisId="rate"
                      tick={{ fontSize: 10, fill: "#0ea5e9" }}
                      tickFormatter={(v) => `₹${v}`}
                      width={55}
                    />
                    <YAxis
                      yAxisId="qty"
                      orientation="right"
                      tick={{ fontSize: 10, fill: "#059669" }}
                      width={40}
                    />
                    <Tooltip content={<PriceTooltip unit={data?.item?.unit}/>}/>
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }}/>
                    <Bar
                      yAxisId="qty"
                      dataKey="qty"
                      name={`Qty (${data?.item?.unit || ""})`}
                      fill="#10b981"
                      fillOpacity={0.55}
                      radius={[3, 3, 0, 0]}
                    />
                    <Line
                      yAxisId="rate"
                      type="monotone"
                      dataKey="rate"
                      name="Rate (₹/unit)"
                      stroke="#0ea5e9"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "#0ea5e9" }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="iu-card overflow-hidden" data-testid="item-price-trend-table">
              <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                Every purchase · newest first
              </div>
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-100">
                      <th className="text-left px-3 py-2">Date</th>
                      <th className="text-left px-2 py-2">Vendor</th>
                      <th className="text-right px-2 py-2">Qty</th>
                      <th className="text-right px-2 py-2">₹/unit</th>
                      <th className="text-right pr-3 pl-2 py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...points].reverse().map((p, i) => (
                      <tr key={`${p.date}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/70">
                        <td className="px-3 py-1.5 tabular-nums text-slate-700">{p.date}</td>
                        <td className="px-2 py-1.5 text-slate-600">{p.vendor_name || <span className="text-slate-400">—</span>}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{fmtQty(p.qty, data?.item?.unit)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-sky-700 font-semibold">₹{inr(p.rate)}</td>
                        <td className="pr-3 pl-2 py-1.5 text-right tabular-nums font-semibold text-emerald-700">₹{inr(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span>Total qty: <b className="tabular-nums">{fmtQty(s.total_qty, data?.item?.unit)}</b> {data?.item?.unit}</span>
                <span>Total spend: <b className="tabular-nums text-emerald-700">₹{inr(s.total_spend)}</b></span>
              </div>
            </div>
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
    rose:    "bg-rose-50 text-rose-800 ring-rose-200",
    slate:   "bg-slate-50 text-slate-800 ring-slate-200",
  };
  return (
    <div className={`rounded-xl ring-1 ${map[tone]} p-3`}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-lg font-extrabold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function PriceTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload || {};
  return (
    <div className="bg-white ring-1 ring-slate-200 shadow-lg rounded-lg p-2 text-xs">
      <div className="font-bold text-slate-900 mb-1">{label}</div>
      <div className="text-sky-700">Rate: ₹{inr(p.rate)} / {unit || "unit"}</div>
      <div className="text-emerald-700">Qty: {fmtQty(p.qty, unit)} {unit || ""}</div>
      <div className="text-slate-600">Amount: ₹{inr(p.amount)}</div>
      {p.vendor_name && <div className="text-slate-500 mt-0.5">From: {p.vendor_name}</div>}
    </div>
  );
}
