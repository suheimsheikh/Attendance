/**
 * MealPriceMoversTab — at-a-glance "which commodities are getting
 * dearer / cheaper" view (Jun 2026 user request).
 *
 * Compares each item's weighted-avg purchase rate in a chosen window
 * against the previous equal-length window and renders:
 *   • KPI strip (rising / falling / new / avg change)
 *   • a diverging horizontal bar chart of the biggest movers
 *   • two lists (biggest increases in red, biggest drops in green)
 *     each with a rate sparkline
 *   • a full table — click any row to open the full price history.
 *
 * Data: GET /api/meals/price-movers?days=&end=
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ReferenceLine, LineChart, Line,
} from "recharts";
import { Loader2, TrendingUp, TrendingDown, ArrowUpRight, ArrowDownRight, Sparkles, IndianRupee } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import ItemPriceTrendDrawer from "../../components/ItemPriceTrendDrawer";

const UP = "#EF4444";
const DOWN = "#10B981";
const rupee = (n) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pctStr = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}%`);

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WINDOWS = [7, 14, 30, 60, 90];

function Kpi({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card !py-2 !px-3 flex items-center gap-2.5 ${tint || ""}`}>
      <Icon size={16} className="shrink-0 opacity-80" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{label}</div>
        <div className="text-lg font-black tabular-nums">{value}</div>
      </div>
    </div>
  );
}

function Sparkline({ points, color }) {
  if (!points || points.length < 2) {
    return <span className="text-[10px] text-slate-300">not enough points</span>;
  }
  return (
    <div style={{ width: 96, height: 30 }} data-testid="pm-sparkline">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
          <Line type="monotone" dataKey="rate" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function MoverRow({ m, onOpen }) {
  const up = (m.change_pct || 0) > 0;
  return (
    <li
      className="flex items-center gap-3 py-2 px-1 rounded-lg hover:bg-slate-50 cursor-pointer"
      onClick={() => onOpen(m)}
      title="Open full price history"
      data-testid={`pm-mover-${m.item_id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-slate-800 truncate">{m.name}</div>
        <div className="text-[11px] text-slate-500 tabular-nums">
          {rupee(m.base_rate)} <span className="mx-1">→</span> <b className="text-slate-700">{rupee(m.cur_rate)}</b>
          <span className="text-slate-400"> /{m.unit || "unit"}</span>
        </div>
      </div>
      <Sparkline points={m.spark} color={up ? UP : DOWN} />
      <div className={`w-20 text-right font-black tabular-nums inline-flex items-center justify-end gap-0.5 ${up ? "text-rose-600" : "text-emerald-600"}`}>
        {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{pctStr(m.change_pct)}
      </div>
    </li>
  );
}

export default function MealPriceMoversTab({ liveSig }) {
  const [days, setDays] = useState(30);
  const [end, setEnd] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawerItem, setDrawerItem] = useState(null);

  useEffect(() => {
    let ok = true;
    setLoading(true);
    api.get(`/meals/price-movers?days=${days}&end=${end}`)
      .then((r) => { if (ok) setData(r); })
      .catch((e) => showApiError(e, "Couldn't load price movers"))
      .finally(() => { if (ok) setLoading(false); });
    return () => { ok = false; };
  }, [days, end, liveSig]);

  const known = useMemo(() => (data?.movers || []).filter((m) => m.change_pct != null), [data]);
  const rising = useMemo(() => known.filter((m) => m.change_pct > 0), [known]);
  const falling = useMemo(() => known.filter((m) => m.change_pct < 0).sort((a, b) => a.change_pct - b.change_pct), [known]);

  // Diverging bar chart: top 15 by absolute change, increases at top.
  const chartData = useMemo(() => {
    const top = [...known].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 15);
    return top.sort((a, b) => b.change_pct - a.change_pct);
  }, [known]);

  const openItem = (m) => setDrawerItem({ id: m.item_id, name: m.name });

  return (
    <div data-testid="meal-price-movers-tab">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="inline-flex items-center gap-1 iu-card !p-1" data-testid="pm-window-picker">
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className={`px-3 h-8 rounded-md text-sm font-semibold transition-colors ${days === w ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              data-testid={`pm-window-${w}`}
            >{w}d</button>
          ))}
        </div>
        <label className="text-xs font-semibold text-slate-600">As of
          <input type="date" value={end} max={todayIso()} onChange={(e) => setEnd(e.target.value)}
                 className="iu-input !h-8 !w-auto ml-2 text-sm" data-testid="pm-end-date" />
        </label>
        {data && (
          <span className="text-xs text-slate-500">
            Comparing <b>{formatDate(data.current.start)}–{formatDate(data.current.end)}</b> vs{" "}
            <b>{formatDate(data.baseline.start)}–{formatDate(data.baseline.end)}</b>
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-center py-16"><Loader2 className="animate-spin inline text-slate-400" /></div>
      ) : !data || (data.movers || []).length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-400" data-testid="pm-empty">
          No items were purchased in this window. Try a wider window or a different end date.
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4" data-testid="pm-kpis">
            <Kpi icon={TrendingUp} label="Getting dearer" value={data.rising_count} tint="bg-rose-50" />
            <Kpi icon={TrendingDown} label="Getting cheaper" value={data.falling_count} tint="bg-emerald-50" />
            <Kpi icon={Sparkles} label="New this window" value={data.new_count} tint="bg-sky-50" />
            <Kpi icon={IndianRupee} label="Avg change" value={pctStr(data.avg_change_pct)} tint="bg-amber-50" />
          </div>

          {/* Diverging bar chart */}
          <div className="iu-card p-4 mb-4" data-testid="pm-chart">
            <h3 className="font-extrabold text-sm mb-1 flex items-center gap-2">
              <TrendingUp size={15} className="text-slate-500" /> Biggest price movers
              <span className="text-[11px] font-normal text-slate-400">— red = dearer, green = cheaper (% vs previous {days} days)</span>
            </h3>
            <div style={{ width: "100%", height: Math.max(220, chartData.length * 30 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical" margin={{ top: 8, right: 40, bottom: 8, left: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                  <XAxis type="number" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} interval={0} />
                  <Tooltip
                    formatter={(v, _n, p) => [`${v > 0 ? "+" : ""}${v}%  (${rupee(p.payload.base_rate)} → ${rupee(p.payload.cur_rate)})`, "Change"]}
                    labelFormatter={() => ""}
                  />
                  <ReferenceLine x={0} stroke="#94a3b8" />
                  <Bar dataKey="change_pct" radius={[3, 3, 3, 3]} isAnimationActive={false}
                       onClick={(bar) => bar && openItem(bar.payload)} cursor="pointer">
                    {chartData.map((m) => (
                      <Cell key={m.item_id} fill={m.change_pct > 0 ? UP : DOWN} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Rising & Falling lists */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
            <div className="iu-card p-4" data-testid="pm-rising-list">
              <h3 className="font-extrabold text-sm mb-2 flex items-center gap-2 text-rose-700">
                <TrendingUp size={15} /> Getting dearer <span className="text-[11px] font-normal text-slate-400">({rising.length})</span>
              </h3>
              <ul className="divide-y divide-slate-100">
                {rising.slice(0, 12).map((m) => <MoverRow key={m.item_id} m={m} onOpen={openItem} />)}
                {rising.length === 0 && <li className="text-sm text-slate-400 py-3">Nothing went up 🎉</li>}
              </ul>
            </div>
            <div className="iu-card p-4" data-testid="pm-falling-list">
              <h3 className="font-extrabold text-sm mb-2 flex items-center gap-2 text-emerald-700">
                <TrendingDown size={15} /> Getting cheaper <span className="text-[11px] font-normal text-slate-400">({falling.length})</span>
              </h3>
              <ul className="divide-y divide-slate-100">
                {falling.slice(0, 12).map((m) => <MoverRow key={m.item_id} m={m} onOpen={openItem} />)}
                {falling.length === 0 && <li className="text-sm text-slate-400 py-3">Nothing came down</li>}
              </ul>
            </div>
          </div>

          {/* Full table */}
          <div className="iu-card overflow-auto" data-testid="pm-table">
            <table className="w-full text-sm">
              <thead className="bg-slate-900 text-white text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="text-left p-2.5">Item</th>
                  <th className="text-left p-2.5">Category</th>
                  <th className="text-right p-2.5">Prev rate</th>
                  <th className="text-right p-2.5">Now</th>
                  <th className="text-center p-2.5">Trend</th>
                  <th className="text-right p-2.5">Change</th>
                </tr>
              </thead>
              <tbody>
                {(data.movers || []).map((m) => {
                  const up = (m.change_pct || 0) > 0;
                  return (
                    <tr key={m.item_id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                        onClick={() => openItem(m)} data-testid={`pm-row-${m.item_id}`}>
                      <td className="p-2 font-semibold text-slate-800">{m.name}</td>
                      <td className="p-2 text-slate-500">{m.category_label || "—"}</td>
                      <td className="p-2 text-right tabular-nums text-slate-500">{rupee(m.base_rate)}</td>
                      <td className="p-2 text-right tabular-nums font-bold text-slate-800">{rupee(m.cur_rate)}</td>
                      <td className="p-2"><div className="flex justify-center"><Sparkline points={m.spark} color={up ? UP : DOWN} /></div></td>
                      <td className={`p-2 text-right font-black tabular-nums ${m.is_new ? "text-sky-600" : up ? "text-rose-600" : "text-emerald-600"}`}>
                        {m.is_new ? "NEW" : pctStr(m.change_pct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {drawerItem && (
        <ItemPriceTrendDrawer
          itemId={drawerItem.id}
          itemName={drawerItem.name}
          onClose={() => setDrawerItem(null)}
        />
      )}
    </div>
  );
}
