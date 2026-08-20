/**
 * KitchenAnalyticsTab — pantry graphics panel.
 *
 * Renders four chart clusters for both PURCHASES and ISSUES over a
 * configurable date window (7d / 30d / 90d / custom):
 *   • Daily trend line (₹ + line count)
 *   • Top items by ₹ (bar)
 *   • Top items by qty (bar)
 *   • Category share (pie)
 * followed by a searchable item-wise table.
 *
 * All numbers come from GET /api/meals/kitchen-analytics.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, TrendingUp, BarChart3, PieChart as PieIcon, ListOrdered, IndianRupee, ShoppingCart, Boxes } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from "recharts";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

const CHART_COLORS = [
  "#2563EB", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
  "#0EA5E9", "#DB2777",
];

const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const inr2 = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function StatPill({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card p-3 flex items-center gap-3 ${tint || ""}`}>
      <div className="w-9 h-9 rounded-lg bg-white/70 flex items-center justify-center shrink-0">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{label}</div>
        <div className="text-lg font-extrabold tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

function DailyTrendChart({ data, colorAmt, colorLines, testid }) {
  const rows = (data || []).map((d) => ({
    date: d.date,
    label: formatDate(d.date),
    Amount: d.amount,
    Lines: d.lines,
  }));
  if (!rows.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  return (
    <div data-testid={testid} style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={20} />
          <YAxis yAxisId="left" tick={{ fontSize: 10 }} tickFormatter={(v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />
          <Tooltip
            formatter={(v, name) => (name === "Amount" ? `₹${inr2(v)}` : v)}
            contentStyle={{ fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line yAxisId="left"  type="monotone" dataKey="Amount" stroke={colorAmt} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
          <Line yAxisId="right" type="monotone" dataKey="Lines" stroke={colorLines} strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TopItemsChart({ items, dataKey, colorFn, label, testid }) {
  const rows = (items || []).slice(0, 10).map((it, i) => ({
    ...it,
    display: it.name,
    _idx: i,
  }));
  if (!rows.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  return (
    <div data-testid={testid} style={{ width: "100%", height: Math.max(220, rows.length * 26) }}>
      <ResponsiveContainer>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => (dataKey === "amount" ? `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}` : v)} />
          <YAxis dataKey="display" type="category" width={110} tick={{ fontSize: 10 }} />
          <Tooltip
            formatter={(v) => (dataKey === "amount" ? `₹${inr2(v)}` : fmtQty(v))}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey={dataKey} name={label} radius={[0, 3, 3, 0]}>
            {rows.map((r) => <Cell key={r.item_id} fill={colorFn(r._idx)} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function CategoryPie({ rows, testid }) {
  const data = (rows || []).filter((r) => r.amount > 0);
  if (!data.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  return (
    <div data-testid={testid} style={{ width: "100%", height: 260 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="amount"
            nameKey="label"
            outerRadius={90}
            innerRadius={45}
            label={(e) => `${e.pct}%`}
            labelLine={false}
          >
            {data.map((r, i) => <Cell key={r.key} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
          </Pie>
          <Tooltip formatter={(v, n) => [`₹${inr2(v)}`, n]} contentStyle={{ fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

function ItemsTable({ items, kind, testid }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items || [];
    return (items || []).filter((r) => (r.name || "").toLowerCase().includes(term));
  }, [items, q]);
  const total = filtered.reduce((s, r) => s + (r.amount || 0), 0);
  return (
    <div className="iu-card" data-testid={testid}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <ListOrdered size={14} className="text-slate-500" />
          <div className="font-bold text-sm">Item-wise {kind}</div>
          <span className="text-xs text-slate-500">({filtered.length} items · ₹{inr(total)})</span>
        </div>
        <input
          type="search"
          placeholder="Search item…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="iu-input !h-8 !w-48 text-xs"
          data-testid={`${testid}-search`}
        />
      </div>
      <div className="overflow-auto max-h-96">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr className="text-slate-600 border-b border-slate-200">
              <th className="px-2 py-1.5 text-left">Item</th>
              <th className="px-2 py-1.5 text-left">Category</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">Unit</th>
              <th className="px-2 py-1.5 text-right">Amount (₹)</th>
              <th className="px-2 py-1.5 text-right">Lines</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="text-center text-slate-400 py-6">No matching rows</td></tr>
            ) : filtered.map((r) => (
              <tr key={r.item_id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`${testid}-row-${r.item_id}`}>
                <td className="px-2 py-1.5 font-semibold text-slate-800">{r.name}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.category_label || r.category_key || "—"}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtQty(r.qty)}</td>
                <td className="px-2 py-1.5 text-right text-slate-500">{r.unit || ""}</td>
                <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{inr2(r.amount)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.lines}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Section({ title, subtitle, accent, data, testKind }) {
  const colorAmt = accent === "purchases" ? "#2563EB" : "#F97316";
  const colorLines = accent === "purchases" ? "#94A3B8" : "#94A3B8";
  return (
    <section className="mb-8" data-testid={`kitchen-analytics-${testKind}`}>
      <div className={`rounded-t-xl px-4 py-2 flex items-center justify-between ${accent === "purchases" ? "bg-blue-50 text-blue-900" : "bg-orange-50 text-orange-900"}`}>
        <div>
          <div className="font-extrabold text-sm">{title}</div>
          <div className="text-[11px] text-slate-500">{subtitle}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">Total</div>
          <div className="text-lg font-extrabold tabular-nums">₹{inr(data?.total_amount || 0)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 mb-3">
        <StatPill icon={IndianRupee} label={`${title} Total`} value={`₹${inr(data?.total_amount || 0)}`} tint="bg-emerald-50" />
        <StatPill icon={Boxes} label="Distinct Items" value={data?.item_count || 0} tint="bg-sky-50" />
        <StatPill icon={ShoppingCart} label="Line Entries" value={data?.total_lines || 0} tint="bg-amber-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><TrendingUp size={14} className="text-slate-500" /><div className="font-bold text-sm">Daily trend</div></div>
          <DailyTrendChart data={data?.daily} colorAmt={colorAmt} colorLines={colorLines} testid={`kitchen-${testKind}-daily`} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Category share</div></div>
          <CategoryPie rows={data?.category_totals} testid={`kitchen-${testKind}-pie`} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by ₹</div></div>
          <TopItemsChart items={data?.top_by_amount} dataKey="amount" colorFn={(i) => CHART_COLORS[i % CHART_COLORS.length]} label="Amount" testid={`kitchen-${testKind}-top-amt`} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by qty</div></div>
          <TopItemsChart items={data?.top_by_qty} dataKey="qty" colorFn={(i) => CHART_COLORS[(i + 3) % CHART_COLORS.length]} label="Qty" testid={`kitchen-${testKind}-top-qty`} />
        </div>
      </div>

      <ItemsTable items={data?.items} kind={title.toLowerCase()} testid={`kitchen-${testKind}-items`} />
    </section>
  );
}

export default function KitchenAnalyticsTab({ liveSig }) {
  const [preset, setPreset] = useState("30");
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (preset === "custom") return;
    const days = parseInt(preset, 10);
    setFrom(isoDaysAgo(days));
    setTo(todayIso());
  }, [preset]);

  useEffect(() => {
    if (!from || !to || from > to) return;
    setLoading(true);
    api.get(`/meals/kitchen-analytics?start=${from}&end=${to}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load kitchen analytics"))
      .finally(() => setLoading(false));
  }, [from, to, liveSig]);

  return (
    <div data-testid="kitchen-analytics-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          {[["7", "7d"], ["30", "30d"], ["90", "90d"], ["custom", "Custom"]].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setPreset(v)}
              className={`px-3 h-9 text-xs font-bold ${preset === v ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid={`kitchen-analytics-preset-${v}`}
            >{l}</button>
          ))}
        </div>
        {preset === "custom" && (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="kitchen-analytics-from" />
            <span className="text-slate-400 text-xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="kitchen-analytics-to" />
          </>
        )}
        <div className="ml-auto text-xs text-slate-500">
          {from && to ? <>Window: <b>{formatDate(from)}</b> — <b>{formatDate(to)}</b></> : null}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : !data ? (
        <div className="text-center text-slate-400 py-12">No data yet.</div>
      ) : (
        <>
          <Section
            title="Purchases"
            subtitle="What came into the pantry"
            accent="purchases"
            data={data.purchases}
            testKind="purchases"
          />
          <Section
            title="Issues"
            subtitle="What was issued to the kitchen (valued at weighted-avg purchase rate)"
            accent="issues"
            data={data.issues}
            testKind="issues"
          />
        </>
      )}
    </div>
  );
}
