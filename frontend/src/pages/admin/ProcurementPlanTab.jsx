/**
 * ProcurementPlanTab — monthly-buy suggestions per item.
 *
 * Backend: GET /api/meals/procurement-plan?horizon_days&history_days&buffer_pct&averaging
 * Formula per item (server-side):
 *     avg_per_day  = <mean|median>(daily issue qty across last `history_days`)
 *     est_use      = avg_per_day × horizon_days
 *     buffer       = est_use × (buffer_pct / 100)
 *     to_buy       = max(0, est_use + buffer − on_hand)
 *
 * UI has three primary surfaces:
 *   • A controls strip (horizon / history / buffer / averaging) that
 *     re-fetches on Apply. Kept explicit so admins understand what
 *     drives the numbers.
 *   • A row-per-item table with urgency-coloured `to_buy` cell and a
 *     rose-red `on_hand` cell when negative — same convention as the
 *     Daily-entry grid.
 *   • A vendor rollup card that lets an admin download / share one
 *     order sheet per supplier.
 *
 * Feb 2026 · Slice 1 of the monthly procurement flow.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ClipboardList, Loader2, Download, RefreshCw, Users, TrendingDown, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

// Indian-format rupee amount (matches KitchenAnalyticsTab's local
// `inr` helper — kept local to avoid a shared-utils PR).
const inr = (n) =>
  Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

// Small utility — the API returns qty to 3 dp. Trim trailing zeros
// for display so "0.500" prints as "0.5" but "6" prints as "6".
function fmtQty(v) {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(3).replace(/\.?0+$/, "");
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, meta) {
  const header = ["Item","Unit","On hand","Avg/day","Est. use","Buffer","To buy","Rate","Est. amount","Days cover","Top vendor"];
  const lines = [
    `# Procurement plan · as of ${meta.as_of} · horizon ${meta.horizon_days}d · history ${meta.history_days}d · buffer ${meta.buffer_pct}% · avg ${meta.averaging}`,
    header.map(csvEscape).join(","),
  ];
  for (const r of rows) {
    lines.push([
      r.name, r.unit, r.on_hand, r.avg_per_day, r.est_use, r.buffer, r.to_buy,
      r.avg_rate, r.est_amount, r.days_cover ?? "", r.top_vendor_name ?? "",
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `procurement-plan-${meta.as_of}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function ProcurementPlanTab({ liveSig }) {
  const [horizon, setHorizon] = useState(30);
  const [history, setHistory] = useState(90);
  const [buffer, setBuffer] = useState(20);
  const [averaging, setAveraging] = useState("median");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showZero, setShowZero] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/meals/procurement-plan", {
        horizon_days: horizon,
        history_days: history,
        buffer_pct: buffer,
        averaging,
      });
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Could not load procurement plan");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [liveSig]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    return showZero ? all : all.filter((r) => r.to_buy > 0 || r.on_hand < 0);
  }, [data, showZero]);

  const vendorRollup = useMemo(() => {
    const g = {};
    for (const r of rows) {
      if (r.to_buy <= 0) continue;
      const key = r.top_vendor_name || "Unassigned";
      const bucket = g[key] || { name: key, items: 0, amount: 0 };
      bucket.items += 1;
      bucket.amount += r.est_amount || 0;
      g[key] = bucket;
    }
    return Object.values(g).sort((a, b) => b.amount - a.amount);
  }, [rows]);

  return (
    <div className="space-y-4" data-testid="procurement-plan-tab">
      {/* Controls strip */}
      <div className="iu-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-slate-700">
          <ClipboardList size={16} className="text-emerald-600" />
          <h2 className="font-extrabold text-sm">Monthly procurement plan</h2>
          <span className="text-[11px] text-slate-500">
            historical-average based · reconciles against current stock
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={load}
              data-testid="plan-refresh"
              className="iu-btn-secondary !h-8 !px-3 !text-xs"
              disabled={loading}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </button>
            <button
              onClick={() => data && downloadCsv(rows, data)}
              data-testid="plan-download"
              className="iu-btn-secondary !h-8 !px-3 !text-xs"
              disabled={!data || rows.length === 0}
              title="Download the current plan (respects the filter toggle)"
            >
              <Download size={12} />
              CSV
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <label className="text-xs">
            <span className="block text-slate-500 mb-0.5">Horizon (days)</span>
            <input
              type="number" min="1" max="180"
              value={horizon}
              onChange={(e) => setHorizon(Math.max(1, +e.target.value || 30))}
              className="iu-input !h-8 !text-sm w-full"
              data-testid="plan-horizon"
            />
          </label>
          <label className="text-xs">
            <span className="block text-slate-500 mb-0.5">History window (days)</span>
            <input
              type="number" min="7" max="365"
              value={history}
              onChange={(e) => setHistory(Math.max(7, +e.target.value || 90))}
              className="iu-input !h-8 !text-sm w-full"
              data-testid="plan-history"
            />
          </label>
          <label className="text-xs">
            <span className="block text-slate-500 mb-0.5">Safety buffer (%)</span>
            <input
              type="number" min="0" max="100" step="5"
              value={buffer}
              onChange={(e) => setBuffer(Math.max(0, +e.target.value || 0))}
              className="iu-input !h-8 !text-sm w-full"
              data-testid="plan-buffer"
            />
          </label>
          <label className="text-xs">
            <span className="block text-slate-500 mb-0.5">Averaging</span>
            <select
              value={averaging}
              onChange={(e) => setAveraging(e.target.value)}
              className="iu-input !h-8 !text-sm w-full"
              data-testid="plan-averaging"
            >
              <option value="median">Median (robust)</option>
              <option value="mean">Mean</option>
            </select>
          </label>
          <div className="text-xs flex items-end">
            <button
              onClick={load}
              disabled={loading}
              data-testid="plan-apply"
              className="iu-btn-primary !h-8 !px-3 !text-xs w-full"
            >
              Apply
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          <strong>To buy</strong> = max(0, (avg × {horizon}) + {buffer}% buffer − on hand). Zero-consumption
          items have no usage signal yet — they only appear here if stock is negative.
        </p>
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <StatPill label="Items in plan" value={rows.filter((r) => r.to_buy > 0).length} tone="emerald" />
          <StatPill
            label="Negative stock"
            value={(data.rows || []).filter((r) => r.on_hand < 0).length}
            tone="rose"
            testid="stat-negative"
          />
          <StatPill
            label="< 10d cover"
            value={(data.rows || []).filter((r) => r.days_cover != null && r.days_cover < 10 && r.est_use > 0).length}
            tone="amber"
          />
          <StatPill label="Est. spend" value={`₹${inr(rows.reduce((s, r) => s + (r.est_amount || 0), 0))}`} tone="violet" />
          <StatPill label="Vendors involved" value={vendorRollup.length} tone="slate" />
        </div>
      )}

      {/* Rows table */}
      <div className="iu-card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100 bg-slate-50">
          <div className="text-xs font-bold text-slate-700 uppercase tracking-wider">Item-level plan</div>
          <label className="text-[11px] text-slate-500 inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={showZero}
              onChange={(e) => setShowZero(e.target.checked)}
              data-testid="plan-show-zero"
            />
            Show items with nothing to buy
          </label>
        </div>
        {loading ? (
          <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-400 text-sm">
            Nothing to procure — every item has enough stock for the current horizon.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="plan-table">
              <thead className="bg-white border-b border-slate-200 text-slate-500 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="py-2 px-3 text-left">Item</th>
                  <th className="py-2 px-3 text-center w-14">Unit</th>
                  <th className="py-2 px-3 text-right w-24">On hand</th>
                  <th className="py-2 px-3 text-right w-20" title="Historical average daily consumption">Avg/day</th>
                  <th className="py-2 px-3 text-right w-24" title={`Avg × ${horizon}`}>Est. use</th>
                  <th className="py-2 px-3 text-right w-20" title={`${buffer}% of Est. use`}>Buffer</th>
                  <th className="py-2 px-3 text-right w-24" title="To buy = max(0, Est. use + buffer − On hand)">To buy</th>
                  <th className="py-2 px-3 text-right w-24">Est. ₹</th>
                  <th className="py-2 px-3 text-center w-16" title="Days of cover at current avg consumption">Cover</th>
                  <th className="py-2 px-3 text-left">Top vendor</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const oh = r.on_hand;
                  const cover = r.days_cover;
                  const urgent = oh < 0 || (cover != null && cover < 10 && r.est_use > 0);
                  const zero = oh === 0 && r.est_use > 0;
                  return (
                    <tr key={r.item_id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`plan-row-${r.item_id}`}>
                      <td className="py-1.5 px-3">
                        <div className="font-semibold text-slate-800">{r.name}</div>
                        <div className="text-[10px] text-slate-400">{r.category_label}</div>
                      </td>
                      <td className="py-1.5 px-3 text-center text-slate-500 text-xs">{r.unit}</td>
                      <td className={`py-1.5 px-3 text-right tabular-nums font-mono ${oh < 0 ? "text-rose-700 font-extrabold" : zero ? "text-rose-500 font-semibold" : "text-slate-700"}`}>
                        {fmtQty(oh)}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-600 text-xs">{fmtQty(r.avg_per_day)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-700 text-xs">{fmtQty(r.est_use)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-500 text-xs">{fmtQty(r.buffer)}</td>
                      <td className={`py-1.5 px-3 text-right tabular-nums font-bold ${r.to_buy > 0 ? (urgent ? "text-rose-700" : "text-emerald-700") : "text-slate-400"}`}>
                        {r.to_buy > 0 ? fmtQty(r.to_buy) : "—"}
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums text-slate-700 text-xs">
                        {r.est_amount > 0 ? `₹${inr(r.est_amount)}` : "—"}
                      </td>
                      <td className="py-1.5 px-3 text-center">
                        {cover == null ? (
                          <span className="text-slate-300 text-xs" title="Never used in the history window">∞</span>
                        ) : (
                          <span className={`text-xs font-semibold ${cover < 10 ? "text-rose-600" : cover < 30 ? "text-amber-600" : "text-emerald-600"}`}>
                            {cover}d
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-3 text-slate-700 text-xs">
                        {r.top_vendor_name || <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Vendor rollup */}
      {vendorRollup.length > 0 && (
        <div className="iu-card p-4" data-testid="plan-vendor-rollup">
          <div className="flex items-center gap-2 mb-3">
            <Users size={14} className="text-emerald-600" />
            <h3 className="text-sm font-extrabold text-slate-800">Group by vendor</h3>
            <span className="text-[11px] text-slate-500">
              Send one order sheet per supplier, sorted by spend.
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {vendorRollup.map((v) => (
              <div key={v.name} className="rounded-md border border-slate-200 bg-slate-50 p-2.5" data-testid={`plan-vendor-${v.name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`}>
                <div className="font-semibold text-slate-800 text-sm truncate">{v.name}</div>
                <div className="text-[11px] text-slate-500">{v.items} item{v.items === 1 ? "" : "s"}</div>
                <div className="text-emerald-700 font-bold tabular-nums mt-0.5">₹{inr(v.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatPill({ label, value, tone = "slate", testid }) {
  const toneMap = {
    slate: "bg-white text-slate-900 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    violet: "bg-violet-50 text-violet-900 border-violet-200",
  };
  return (
    <div className={`px-3 py-1.5 rounded-md border ${toneMap[tone]}`} data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-lg font-extrabold tabular-nums leading-none mt-0.5">{value}</div>
    </div>
  );
}
