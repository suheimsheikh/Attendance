/**
 * KitchenAnalyticsTab — pantry graphics panel.
 *
 * Renders four chart clusters for both PURCHASES and ISSUES over a
 * selectable date window — a single month (prev / next / this-month) or a
 * custom date range:
 *   • Spend trend: weekly ₹ bars + monthly ₹ total line (dual axis)
 *   • Top items by ₹ (bar)
 *   • Top items by qty (bar)
 *   • Category share (pie)
 * followed by a searchable item-wise table.
 *
 * All numbers come from GET /api/meals/kitchen-analytics.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, TrendingUp, BarChart3, PieChart as PieIcon, ListOrdered, IndianRupee, ShoppingCart, Boxes, Flame, Beef, Wheat, Droplet, Maximize2, X as CloseIcon, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell, LabelList, ComposedChart,
} from "recharts";
import { api, showApiError } from "../../api";
import { formatDate, fmtQty as uQty } from "../../utils";

// Same palette + a deterministic (item_id → colour) mapping so the
// same item paints in the same colour across ALL charts on this
// screen (Top items by ₹, Top items by qty, focused Daily-trend).
const CHART_COLORS = [
  "#2563EB", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
  "#0EA5E9", "#DB2777",
];

// Deterministic (item_id → colour) mapping. Uses a tiny string hash
// so "Rice" is always the same colour across every chart on the
// screen without needing a shared React context. Same UUID → same
// palette index → same colour, session after session.
function colorForItem(id) {
  if (!id) return CHART_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return CHART_COLORS[h % CHART_COLORS.length];
}

const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const inr2 = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n, unit) =>
  n == null ? "—" : uQty(n, unit);

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
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

function BannerStat({ icon: Icon, label, value }) {
  // Chip variant of StatPill rendered INSIDE the coloured banner.
  // Uses translucent white for readable contrast on both the blue
  // (Purchases) and orange (Consumption) bands.
  return (
    <div className="rounded-lg bg-white/15 backdrop-blur-sm px-3 py-2 flex items-center gap-2.5 min-w-0">
      <div className="w-8 h-8 rounded-md bg-white/25 flex items-center justify-center shrink-0">
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-bold opacity-80">{label}</div>
        <div className="text-base sm:text-lg font-black tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

function makeDotRenderer(seriesKey, color, fullscreen) {
  // Skip rendering a dot for zero-value points so weeks of empty
  // days don't turn the X-axis into a solid line of clutter. Named
  // (not anonymous) so React can key it stably across renders.
  const r = fullscreen ? 3 : 2;
  return function ZeroSkipDot({ cx, cy, payload, index }) {
    if (cx == null || cy == null) return null;
    if (!payload || !payload[seriesKey]) return null;
    return (
      <circle
        key={`${seriesKey}-dot-${index}`}
        cx={cx} cy={cy} r={r} fill={color} stroke="none"
      />
    );
  };
}

// Bucket the sparse daily series into weekly ₹ totals (bars) plus each
// week's calendar-month ₹ total (line overlay). Weeks start Monday and
// are labelled by their start date. A week is attributed to the month of
// its Monday for the monthly-total line.
function weekStartIso(iso) {
  const d = new Date(iso + "T00:00:00");
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function buildWeeklyMonthly(daily, catKeys) {
  if (!daily || !daily.length) return [];
  const weekMap = new Map();     // weekStartIso -> { total, cat:{} }
  const monthTotal = new Map();  // "YYYY-MM"   -> ₹
  for (const d of daily) {
    if (!d?.date) continue;
    const amt = Number(d.amount) || 0;
    const ws = weekStartIso(d.date);
    const wk = weekMap.get(ws) || { total: 0, cat: {} };
    wk.total += amt;
    for (const [k, v] of Object.entries(d.cat || {})) wk.cat[k] = (wk.cat[k] || 0) + (Number(v) || 0);
    weekMap.set(ws, wk);
    const mk = d.date.slice(0, 7);
    monthTotal.set(mk, (monthTotal.get(mk) || 0) + amt);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const weeks = [...weekMap.keys()].sort();
  return weeks.map((ws, i) => {
    const mk = ws.slice(0, 7);
    const nextMk = i + 1 < weeks.length ? weeks[i + 1].slice(0, 7) : null;
    const wk = weekMap.get(ws);
    const row = {
      key: ws,
      label: new Date(ws + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
      weekly: r2(wk.total),
      monthly: r2(monthTotal.get(mk) || 0),
      // Month-total label shown only on the LAST week of each month run
      // so the stepped line isn't labelled on every point.
      monthLabel: mk !== nextMk ? r2(monthTotal.get(mk) || 0) : null,
    };
    (catKeys || []).forEach((k) => { row[k] = r2(wk.cat[k] || 0); });
    return row;
  });
}

function WeeklyStackTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const catRows = payload.filter((p) => p.dataKey !== "monthly" && (p.value || 0) > 0);
  const weekTotal = catRows.reduce((s, p) => s + (p.value || 0), 0);
  const monthEntry = payload.find((p) => p.dataKey === "monthly");
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow p-2 text-xs min-w-[180px]">
      <div className="font-bold mb-1">Week of {label}</div>
      {catRows.slice().sort((a, b) => b.value - a.value).map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: p.color }} />
          <span className="flex-1 truncate text-slate-600">{p.name}</span>
          <span className="tabular-nums font-semibold text-slate-700">₹{inr2(p.value)}</span>
        </div>
      ))}
      <div className="mt-1 pt-1 border-t border-slate-100 flex justify-between font-bold text-slate-800">
        <span>Week total</span><span className="tabular-nums">₹{inr2(weekTotal)}</span>
      </div>
      {monthEntry && (
        <div className="flex justify-between text-slate-500">
          <span>Month total</span><span className="tabular-nums">₹{inr2(monthEntry.value)}</span>
        </div>
      )}
    </div>
  );
}

function DailyTrendChart({ data, colorAmt, categoryTotals, testid, onDayClick, height = 260, fullscreen = false, focusSeries, from, to }) {
  const useFocus = !!(focusSeries && focusSeries.items && focusSeries.items.length && from && to);
  const fontSize = fullscreen ? 12 : 10;

  // Drill-down: when a Top-items bar is tapped, keep the per-item DAILY
  // lines (unchanged) so a coach can trace one ingredient day by day.
  if (useFocus) {
    const rows = buildFocusRows(focusSeries.items, from, to);
    if (!rows.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
    const handleDivClick = (e) => {
      if (!onDayClick) return;
      const grid = e.currentTarget.querySelector(".recharts-cartesian-grid");
      const rect = grid?.getBoundingClientRect ? grid.getBoundingClientRect() : e.currentTarget.getBoundingClientRect();
      if (!rect.width) return;
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const idx = Math.round(frac * (rows.length - 1));
      const day = rows[idx]?.date;
      if (day) onDayClick(day);
    };
    return (
      <div data-testid={testid} style={{ width: "100%", height, cursor: onDayClick ? "pointer" : "default" }} onClick={handleDivClick}>
        <ResponsiveContainer>
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="label" tick={{ fontSize }} interval="preserveStartEnd" minTickGap={20} />
            <YAxis tick={{ fontSize }} tickFormatter={(v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} />
            <Tooltip content={<FocusDailyTooltip itemUnitById={focusUnitMap(focusSeries)} />} contentStyle={{ fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: fullscreen ? 13 : 11 }} />
            {focusSeries.items.map((it) => (
              <Line
                key={it.item_id}
                type="monotone" dataKey={it.item_id}
                name={it.name}
                stroke={colorForItem(it.item_id)}
                strokeWidth={2}
                dot={makeDotRenderer(it.item_id, colorForItem(it.item_id), fullscreen)}
                activeDot={{ r: onDayClick ? 6 : 5, style: { cursor: onDayClick ? "pointer" : "default" } }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Default: WEEKLY spend as bars STACKED BY CATEGORY + a MONTHLY-total
  // line overlay (dual ₹ axis so the larger monthly figure stays readable).
  // Each week's bar shows the total ₹ on top; the month total is labelled
  // on the last week of each month.
  const catList = (categoryTotals || []).filter((c) => (c.amount || 0) > 0);
  const catKeys = catList.map((c) => c.key);
  const catLabel = Object.fromEntries(catList.map((c) => [c.key, c.label]));
  const catColor = Object.fromEntries(catList.map((c, i) => [c.key, CHART_COLORS[i % CHART_COLORS.length]]));
  const rows = buildWeeklyMonthly(data, catKeys);
  if (!rows.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  const rupeeK = (v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : Math.round(v)}`;
  const labelFont = { fontSize: fullscreen ? 12 : 9, fontWeight: 700 };
  const barKeys = catKeys.length ? catKeys : ["weekly"];
  return (
    <div data-testid={testid} style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <ComposedChart data={rows} margin={{ top: 20, right: 16, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize }} interval={0} />
          <YAxis yAxisId="left" tick={{ fontSize }} tickFormatter={rupeeK} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize }} tickFormatter={rupeeK} />
          <Tooltip content={<WeeklyStackTooltip />} />
          <Legend wrapperStyle={{ fontSize: fullscreen ? 12 : 10 }} />
          {barKeys.map((k, i) => {
            const isTop = i === barKeys.length - 1;
            return (
              <Bar
                key={k}
                yAxisId="left"
                dataKey={k}
                name={catLabel[k] || "Weekly spend"}
                stackId="w"
                fill={catColor[k] || colorAmt}
                maxBarSize={fullscreen ? 64 : 40}
                isAnimationActive={false}
              >
                {isTop && (
                  <LabelList dataKey="weekly" position="top" formatter={rupeeK} style={{ ...labelFont, fill: "#334155" }} />
                )}
              </Bar>
            );
          })}
          <Line yAxisId="right" type="stepAfter" dataKey="monthly" name="Month total" stroke="#0F172A" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false}>
            <LabelList dataKey="monthLabel" position="top" formatter={(v) => (v == null ? "" : rupeeK(v))} style={{ ...labelFont, fill: "#0F172A" }} />
          </Line>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function focusUnitMap(focusSeries) {
  // Small helper so the FocusDailyTooltip can look up unit for the
  // hovered series in O(1). Recomputed each render is fine — a
  // focused list is 1-8 items.
  const out = {};
  (focusSeries?.items || []).forEach((it) => { out[it.item_id] = it.unit || ""; });
  return out;
}

function buildFocusRows(items, from, to) {
  // Walk every day in [from, to] and pick amount + qty from each
  // item's sparse daily list. Missing days become 0 so the lines
  // are visually continuous. Qty is stored as `${item_id}__qty` so
  // the custom tooltip can surface it alongside the ₹ series.
  //
  // NB (Feb 2026 code review): must derive ISO from LOCAL parts —
  // `Date#toISOString()` converts to UTC, which shifts back by a day
  // in any +offset zone (IST is +05:30), so a local-midnight Date
  // maps to the previous calendar day and every `p.amt.get(iso)`
  // lookup misses. Confirmed by the review as a MEDIUM defect.
  const localIso = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  const start = new Date(from + "T00:00:00");
  const end = new Date(to + "T00:00:00");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const perItem = items.map((it) => {
    const amt = new Map();
    const qty = new Map();
    (it.daily || []).forEach((r) => {
      amt.set(r.date, r.amount);
      qty.set(r.date, r.qty);
    });
    return { id: it.item_id, amt, qty };
  });
  const out = [];
  const d = new Date(start);
  while (d <= end) {
    const iso = localIso(d);
    const row = { date: iso, label: formatDate(iso) };
    perItem.forEach((p) => {
      row[p.id] = p.amt.get(iso) || 0;
      row[`${p.id}__qty`] = p.qty.get(iso) || 0;
    });
    out.push(row);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function TopItemsTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const r = payload[0]?.payload;
  if (!r) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-md shadow px-2.5 py-2 text-xs min-w-[180px]">
      <div className="font-bold text-slate-800">{r.name}{r.unit ? <span className="text-slate-400 font-normal ml-1">({r.unit})</span> : null}</div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
        <span className="text-slate-500">Amount</span>
        <span className="tabular-nums text-slate-800 text-right font-semibold">₹{inr2(r.amount)}</span>
        <span className="text-slate-500">Qty</span>
        <span className="tabular-nums text-slate-800 text-right font-semibold">{fmtQty(r.qty, r.unit)}{r.unit ? <span className="text-slate-400 font-normal ml-0.5">{r.unit}</span> : null}</span>
        <span className="text-slate-500">Lines</span>
        <span className="tabular-nums text-slate-800 text-right">{r.lines}</span>
      </div>
      {r.top_vendors && r.top_vendors.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-slate-100">
          <div className="text-[9px] uppercase tracking-wider font-bold text-slate-500 mb-0.5">Top vendors</div>
          {r.top_vendors.map((v, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="text-slate-700 truncate">{v.name}</span>
              <span className="ml-auto tabular-nums text-slate-500">₹{inr(v.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FocusDailyTooltip({ active, payload, label, itemUnitById }) {
  if (!active || !payload?.length) return null;
  const nonZero = payload.filter((p) => (p.value || 0) > 0);
  if (!nonZero.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div className="bg-white border border-slate-200 rounded-md shadow px-2.5 py-2 text-xs min-w-[220px]">
      <div className="font-bold text-slate-800">{label}</div>
      <div className="mt-1 space-y-0.5">
        {nonZero.map((p) => {
          const qty = row[`${p.dataKey}__qty`];
          const unit = itemUnitById?.[p.dataKey];
          return (
            <div key={p.dataKey} className="flex items-baseline gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
              <span className="text-slate-700">{p.name}</span>
              <span className="ml-auto tabular-nums text-slate-800 font-semibold">₹{inr2(p.value)}</span>
              {qty > 0 && <span className="tabular-nums text-slate-400 text-[10px]">{fmtQty(qty)}{unit ? unit : ""}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Adaptive value label for the horizontal bar charts (Top items and
// Top vendors). If the bar is wide enough we paint the value INSIDE
// the bar in white; otherwise we drop it just to the right in the
// slate ink so tiny bars still get their number. Added Feb 2026 after
// user asked to always see amounts on the bars.
function makeBarValueLabel(formatter, { minInsidePx = 46, offset = 4 } = {}) {
  return function BarValueLabel(props) {
    const { x, y, width, height, value } = props;
    if (value == null) return null;
    const text = formatter(value);
    const inside = width >= minInsidePx;
    const cx = inside ? x + width - offset : x + width + offset;
    const anchor = inside ? "end" : "start";
    const fill = inside ? "#ffffff" : "#334155";
    const fontWeight = inside ? 700 : 600;
    return (
      <text
        x={cx}
        y={y + height / 2}
        dy={3}
        textAnchor={anchor}
        fill={fill}
        fontSize={10}
        fontWeight={fontWeight}
        style={{ pointerEvents: "none" }}
      >
        {text}
      </text>
    );
  };
}

function TopItemsChart({ items, dataKey, colorFn, label, testid, showUnit, onToggleItem, focusedIds }) {
  // Show ALL items sorted desc by the current metric (previously
  // capped at 10). Card body scrolls internally so the strip stays
  // compact next to Category share, but power-users can scroll to
  // find any of the ~100 pantry items.
  const rows = (items || []).map((it, i) => ({
    ...it,
    display: showUnit && it.unit ? `${it.name} (${it.unit})` : it.name,
    _idx: i,
    _focused: focusedIds ? focusedIds.has(it.item_id) : false,
  }));
  if (!rows.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  // A 22px row keeps labels readable; container height fixed at 260px
  // so a category-share pie next to it stays visually anchored.
  const rowH = 22;
  const innerH = Math.max(220, rows.length * rowH);
  return (
    <div className="max-h-[260px] overflow-y-auto pr-1" data-testid={testid}>
      <div style={{ width: "100%", height: innerH }}>
      <ResponsiveContainer>
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 4, right: 56, left: 4, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => (dataKey === "amount" ? `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}` : v)} />
          <YAxis dataKey="display" type="category" width={110} tick={{ fontSize: 10 }} />
          <Tooltip
            content={<TopItemsTooltip />}
            cursor={onToggleItem ? { fill: "rgba(148,163,184,0.15)" } : false}
          />
          <Bar
            dataKey={dataKey} name={label} radius={[0, 3, 3, 0]}
            onClick={onToggleItem ? (payload) => {
              // Recharts <Bar onClick> passes the row data as payload.
              // The item_id is the identity — flip its focus state.
              const iid = payload?.item_id;
              if (iid) onToggleItem(iid);
            } : undefined}
            style={onToggleItem ? { cursor: "pointer" } : undefined}
          >
            {rows.map((r) => (
              <Cell
                key={r.item_id}
                fill={colorForItem(r.item_id)}
                fillOpacity={focusedIds && focusedIds.size > 0 && !r._focused ? 0.35 : 1}
                stroke={r._focused ? "#0F172A" : "none"}
                strokeWidth={r._focused ? 2 : 0}
              />
            ))}
            <LabelList
              dataKey={dataKey}
              content={makeBarValueLabel(
                dataKey === "amount"
                  ? (v) => `₹${inr(v)}`
                  : (v) => fmtQty(v),
              )}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

function CategoryPie({ rows, testid }) {
  const data = (rows || []).filter((r) => r.amount > 0)
    .slice().sort((a, b) => (b.amount || 0) - (a.amount || 0));
  if (!data.length) return <div className="text-center text-slate-400 text-sm py-8">No data</div>;
  const total = data.reduce((s, r) => s + (r.amount || 0), 0);
  return (
    <div data-testid={testid} className="flex flex-col items-center">
      {/* Clean donut — no perimeter labels (they overlap when categories
          are many + the column is narrow). Total sits in the centre; the
          per-category breakdown lives in the readable legend list below. */}
      <div style={{ width: "100%", height: 200, position: "relative" }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="amount"
              nameKey="label"
              outerRadius={86}
              innerRadius={54}
              paddingAngle={1}
              stroke="#fff"
              strokeWidth={1}
              isAnimationActive={false}
            >
              {data.map((r, i) => <Cell key={r.key} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [`₹${inr2(v)}`, n]} contentStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
          aria-hidden="true"
        >
          <div className="text-[10px] uppercase tracking-wide text-slate-400 leading-none">Total</div>
          <div className="text-sm font-bold text-slate-700 leading-tight mt-0.5">₹{inr(total)}</div>
        </div>
      </div>
      <ul className="w-full mt-2 space-y-1" data-testid={`${testid}-legend`}>
        {data.map((r, i) => (
          <li
            key={r.key}
            className="flex items-center gap-2 text-[11px]"
            title={`${r.label}: ₹${inr2(r.amount)} (${r.pct}%)`}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
            />
            <span className="flex-1 min-w-0 truncate text-slate-700">{r.label}</span>
            <span className="tabular-nums font-semibold text-slate-600 w-9 text-right">{r.pct}%</span>
            <span className="tabular-nums text-slate-400 w-16 text-right">₹{inr(r.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TopVendorsTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-md bg-white shadow-md border border-slate-200 px-3 py-2 text-xs" style={{ minWidth: 180 }}>
      <div className="font-bold text-slate-900">{r.name}</div>
      <div className="text-slate-600 mt-0.5">₹{inr(r.amount)} · <span className="font-semibold">{r.pct}%</span> of spend</div>
      <div className="text-slate-500 mt-0.5">{r.purchases} purchase{r.purchases === 1 ? "" : "s"}</div>
    </div>
  );
}

function TopVendorsChart({ vendors, testid }) {
  // Horizontal bar chart of vendors sorted by spend (₹), so admins can
  // see at a glance who they lean on most in the selected window.
  // Follows the same pattern as `TopItemsChart` — scrollable wrapper,
  // fixed row height, consistent palette-hashed colours. Added Feb 2026
  // in response to user request for a vendor-share view.
  const rows = (vendors || []).filter((v) => v.amount > 0);
  if (!rows.length) {
    return <div className="text-center text-slate-400 text-sm py-8">No vendor data in this window</div>;
  }
  const rowH = 28;
  const innerH = Math.max(240, rows.length * rowH);
  // Hash colours off the vendor_id (or name for "Unknown / not set")
  // so the same vendor always paints the same shade across sessions.
  const colorFor = (r) => {
    const key = r.vendor_id || r.name;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = ((h * 31) + key.charCodeAt(i)) >>> 0;
    return CHART_COLORS[h % CHART_COLORS.length];
  };
  return (
    <div className="max-h-[260px] overflow-y-auto pr-1" data-testid={testid}>
      <div style={{ width: "100%", height: innerH }}>
        <ResponsiveContainer>
          <BarChart data={rows} layout="vertical" margin={{ top: 12, right: 68, left: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => `₹${v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}`} />
            <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 10 }} />
            <Tooltip content={<TopVendorsTooltip />} cursor={{ fill: "rgba(148,163,184,0.15)" }} />
            <Bar dataKey="amount" name="Spend" radius={[0, 3, 3, 0]}>
              {rows.map((r) => (
                <Cell key={r.vendor_id || r.name} fill={colorFor(r)} />
              ))}
              <LabelList
                dataKey="amount"
                content={makeBarValueLabel((v) => `₹${inr(v)}`)}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
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

function Section({ title, subtitle, accent, data, testKind, first, from, to }) {
  const colorAmt = accent === "purchases" ? "#2563EB" : "#F97316";
  const bandBg = accent === "purchases" ? "bg-blue-600" : "bg-orange-600";
  const bandFg = "text-white";
  const kind = accent === "purchases" ? "purchases" : "issues";
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const [focusedIds, setFocusedIds] = useState(() => new Set());
  const [focusSeries, setFocusSeries] = useState(null);
  const [focusLoading, setFocusLoading] = useState(false);
  useEffect(() => {
    if (!fullscreen && !selectedDay) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (selectedDay) setSelectedDay(null);
      else if (fullscreen) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, selectedDay]);
  // Whenever the focused set changes, refetch per-item daily data.
  // Empty set → no fetch; the daily chart falls back to aggregate.
  useEffect(() => {
    if (focusedIds.size === 0 || !from || !to) { setFocusSeries(null); return; }
    let ignore = false;
    setFocusLoading(true);
    const ids = Array.from(focusedIds).join(",");
    api.get(`/meals/kitchen-analytics/item-daily?start=${from}&end=${to}&item_ids=${ids}&kind=${kind}`)
      .then((r) => { if (!ignore) setFocusSeries(r); })
      .catch((err) => { if (!ignore) showApiError(err, "Couldn't load item series"); })
      .finally(() => { if (!ignore) setFocusLoading(false); });
    return () => { ignore = true; };
  }, [focusedIds, from, to, kind]);
  const openDay = (d) => setSelectedDay(d);
  const toggleItem = (iid) => setFocusedIds((prev) => {
    const nxt = new Set(prev);
    if (nxt.has(iid)) nxt.delete(iid); else nxt.add(iid);
    return nxt;
  });
  const clearFocus = () => setFocusedIds(new Set());
  return (
    <section className={`mb-10 ${first ? "" : "pt-8 mt-8 border-t-[6px] border-slate-900/80"}`} data-testid={`kitchen-analytics-${testKind}`}>
      {/* Banner: title + three inline stat chips + rupee total.  The
          three chips (Total / Items / Lines) used to sit below the
          banner as separate cards; folding them in reclaims a full
          strip of vertical space above the charts. */}
      <div className={`rounded-xl px-6 py-4 shadow-lg ${bandBg} ${bandFg} mb-4`} data-testid={`kitchen-${testKind}-band`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-4xl sm:text-5xl font-black uppercase tracking-widest leading-none" data-testid={`kitchen-${testKind}-title`}>{title}</div>
            <div className="text-sm opacity-90 mt-2">{subtitle}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider font-bold opacity-80">Total</div>
            <div className="text-3xl sm:text-4xl font-black tabular-nums">₹{inr(data?.total_amount || 0)}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <BannerStat icon={IndianRupee} label={`${title} Total`} value={`₹${inr(data?.total_amount || 0)}`} />
          <BannerStat icon={Boxes} label="Distinct Items" value={data?.item_count || 0} />
          <BannerStat icon={ShoppingCart} label="Line Entries" value={data?.total_lines || 0} />
        </div>
      </div>
      {accent === "purchases" && (data?.unitemised_amount || 0) > 0 && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900" data-testid={`kitchen-${testKind}-unitemised-note`}>
          <b>₹{inr(data.unitemised_amount)}</b> of this window&apos;s purchase spend came from bulk-uploaded / legacy days that only carry category totals (no per-item detail). Those rupees appear in <b>Category share</b> but not in <b>Top items</b> or the item-wise table.
        </div>
      )}

      {/* Full-width Daily trend so the whole time series is visible
          at a glance. The three narrower charts live in the row
          below at 3-across. */}
      <div className="iu-card p-3 mb-3">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <TrendingUp size={14} className="text-slate-500" />
          <div className="font-bold text-sm">Spend trend</div>
          {focusedIds.size > 0 ? (
            <>
              <span className="text-[10px] text-slate-400 ml-1">· focused on:</span>
              {(focusSeries?.items || []).map((it) => (
                <span
                  key={it.item_id}
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white rounded px-1.5 py-0.5"
                  style={{ background: colorForItem(it.item_id) }}
                >
                  {it.name}
                  <button type="button" onClick={() => toggleItem(it.item_id)} className="opacity-80 hover:opacity-100" title="Remove">
                    <CloseIcon size={10} />
                  </button>
                </span>
              ))}
              <button
                type="button" onClick={clearFocus}
                className="text-[10px] font-bold text-slate-500 hover:text-slate-800 underline"
                data-testid={`kitchen-${testKind}-focus-clear`}
              >Clear</button>
              {focusLoading && <Loader2 size={12} className="animate-spin text-slate-400" />}
            </>
          ) : (
            <span className="hidden sm:inline text-[10px] text-slate-400 ml-1">· weekly spend stacked by category + month total · tap a bar below to focus one item</span>
          )}
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="ml-auto p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
            title="Expand to full screen"
            data-testid={`kitchen-${testKind}-daily-fullscreen`}
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <DailyTrendChart
          data={data?.daily} colorAmt={colorAmt}
          categoryTotals={data?.category_totals}
          testid={`kitchen-${testKind}-daily`}
          onDayClick={openDay} height={280}
          focusSeries={focusSeries} from={from} to={to}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Category share</div></div>
          <CategoryPie rows={data?.category_totals} testid={`kitchen-${testKind}-pie`} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by ₹</div><span className="text-[10px] text-slate-400">· tap to focus</span></div>
          <TopItemsChart items={data?.top_by_amount} dataKey="amount" colorFn={(i) => CHART_COLORS[i % CHART_COLORS.length]} label="Amount" testid={`kitchen-${testKind}-top-amt`} onToggleItem={toggleItem} focusedIds={focusedIds} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by qty</div><span className="text-[10px] text-slate-400">(kg items only · tap to focus)</span></div>
          <TopItemsChart items={data?.top_by_qty} dataKey="qty" colorFn={(i) => CHART_COLORS[(i + 3) % CHART_COLORS.length]} label="Qty (kg)" testid={`kitchen-${testKind}-top-qty`} onToggleItem={toggleItem} focusedIds={focusedIds} />
        </div>
      </div>

      {accent === "purchases" && (
        <div className="iu-card p-3 mb-3" data-testid={`kitchen-${testKind}-top-vendors-card`}>
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500" />
            <div className="font-bold text-sm">Top vendors by ₹</div>
            <span className="text-[10px] text-slate-400">· who you lean on most in this window</span>
          </div>
          <TopVendorsChart vendors={data?.top_vendors} testid={`kitchen-${testKind}-top-vendors`} />
        </div>
      )}

      <ItemsTable items={data?.items} kind={title.toLowerCase()} testid={`kitchen-${testKind}-items`} />

      {data?.nutrition && <NutritionBlock nutrition={data.nutrition} testKind={testKind} accent={accent} />}

      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-white p-4 sm:p-6 flex flex-col"
          role="dialog"
          onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
          data-testid={`kitchen-${testKind}-daily-fs-modal`}
        >
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className={accent === "purchases" ? "text-blue-600" : "text-orange-600"} />
            <h2 className="font-black text-xl">{title} · Spend trend</h2>
            <span className="text-xs text-slate-400 ml-2">Tap any day to see the line-level detail</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 !min-h-[44px] !min-w-[44px]"
              title="Close (Esc)"
              data-testid={`kitchen-${testKind}-daily-fs-close`}
            >
              <CloseIcon size={18} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <DailyTrendChart
              data={data?.daily}
              colorAmt={colorAmt}
              categoryTotals={data?.category_totals}
              testid={`kitchen-${testKind}-daily-fs`}
              onDayClick={openDay}
              height={Math.max(320, window.innerHeight - 160)}
              fullscreen
              focusSeries={focusSeries} from={from} to={to}
            />
          </div>
        </div>
      )}

      {selectedDay && (
        <PantryDayModal
          date={selectedDay}
          kind={kind}
          accent={accent}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </section>
  );
}

const MACRO_COLORS = {
  protein: "#DC2626",
  carbs:   "#F59E0B",
  fat:     "#8B5CF6",
  fibre:   "#10B981",
};
const KG_G = (g) => (g == null ? "—" : g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.round(g)} g`);

function NutritionBlock({ nutrition, testKind, accent }) {
  const cov = nutrition.coverage || {};
  const macros = nutrition.macro_grams || [];
  const kcalPie = nutrition.kcal_pie || [];
  const dailyKcal = (nutrition.daily_kcal || []).map((d) => ({
    ...d,
    label: formatDate(d.date),
  }));
  const kcalColor = accent === "purchases" ? "#DC2626" : "#EA580C";
  const missing = cov.qty_pct != null ? Math.max(0, 100 - cov.qty_pct) : 0;
  return (
    <div className="mt-5" data-testid={`kitchen-${testKind}-nutrition`}>
      <div className="flex items-center gap-2 mb-2">
        <Flame size={16} className="text-rose-600" />
        <div className="font-extrabold text-sm">Nutrition</div>
        {missing > 0 && (
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200"
            title={`${cov.items_covered}/${cov.items_total} items have nutrition data`}
            data-testid={`kitchen-${testKind}-nutrition-coverage`}
          >
            {missing.toFixed(0)}% of qty has no nutrition data — chart is based on {cov.qty_pct}%
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        <StatPill icon={Flame}   label="Total kcal"  value={inr(nutrition.kcal_total || 0)} tint="bg-rose-50" />
        <StatPill icon={Beef}    label="Protein"     value={KG_G(nutrition.totals?.protein_g)} tint="bg-red-50" />
        <StatPill icon={Wheat}   label="Carbs"       value={KG_G(nutrition.totals?.carbs_g)} tint="bg-amber-50" />
        <StatPill icon={Droplet} label="Fat"         value={KG_G(nutrition.totals?.fat_g)} tint="bg-violet-50" />
        <StatPill icon={Boxes}   label="Fibre"       value={KG_G(nutrition.totals?.fibre_g)} tint="bg-emerald-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><TrendingUp size={14} className="text-slate-500" /><div className="font-bold text-sm">Daily calories</div></div>
          {(dailyKcal.length === 0)
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-daily`}>
                <ResponsiveContainer>
                  <LineChart data={dailyKcal} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={20} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                    <Tooltip formatter={(v) => `${inr(v)} kcal`} contentStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="kcal" name="kcal" stroke={kcalColor} strokeWidth={2} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Macros (grams)</div></div>
          {(macros.every((m) => (m.grams || 0) === 0))
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-macros`}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={macros} dataKey="grams" nameKey="label" outerRadius={80} innerRadius={40}
                         label={(e) => (e.pct >= 6 ? `${e.pct}%` : "")} labelLine={false}>
                      {macros.map((m) => <Cell key={m.key} fill={MACRO_COLORS[m.key]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [KG_G(v), n]} contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Calorie source</div><span className="text-[10px] text-slate-400">(kcal from macro)</span></div>
          {(kcalPie.every((m) => (m.kcal || 0) === 0))
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-kcalpie`}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={kcalPie} dataKey="kcal" nameKey="label" outerRadius={80} innerRadius={40}
                         label={(e) => (e.pct >= 6 ? `${e.pct}%` : "")} labelLine={false}>
                      {kcalPie.map((m) => <Cell key={m.key} fill={MACRO_COLORS[m.key]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`${inr(v)} kcal`, n]} contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by calories</div></div>
          {((nutrition.top_by_kcal || []).length === 0)
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: Math.max(220, (nutrition.top_by_kcal.slice(0, 10).length * 26)) }} data-testid={`kitchen-${testKind}-nutrition-top-kcal`}>
                <ResponsiveContainer>
                  <BarChart data={(nutrition.top_by_kcal || []).slice(0, 10)} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                    <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => `${inr(v)} kcal`} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="kcal" name="kcal" radius={[0, 3, 3, 0]}>
                      {(nutrition.top_by_kcal || []).slice(0, 10).map((r, i) => <Cell key={r.item_id} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function PantryDayModal({ date, kind, accent, onClose }) {
  // Fetches /meals/pantry-day-detail once for the clicked day and
  // renders a compact table: item + qty + rate + amount (+ vendor
  // for purchases). Bulk-uploaded category totals surface as
  // separate "unitemised" rows so the ₹ math ties out to the chart.
  const [state, setState] = useState({ loading: true, data: null });
  useEffect(() => {
    setState({ loading: true, data: null });
    api.get(`/meals/pantry-day-detail?date=${date}&kind=${kind}`)
      .then((r) => setState({ loading: false, data: r }))
      .catch((err) => {
        showApiError(err, "Couldn't load day detail");
        setState({ loading: false, data: null });
      });
  }, [date, kind]);
  const headerBg = accent === "purchases" ? "bg-blue-700" : "bg-orange-600";
  const dateLabel = formatDate(date);
  const { loading, data } = state;
  const isPurchase = kind === "purchases";
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      onClick={onClose}
      data-testid={`kitchen-${kind}-day-modal`}
    >
      <div
        className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`px-5 py-3 flex items-center gap-2 shrink-0 text-white ${headerBg}`}>
          <ListOrdered size={18} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest opacity-80">{isPurchase ? "Purchases" : "Issues"}</div>
            <div className="font-black text-lg truncate">{dateLabel}</div>
          </div>
          <div className="ml-auto" />
          <button
            type="button" onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/10"
            title="Close (Esc)"
            data-testid={`kitchen-${kind}-day-modal-close`}
          >
            <CloseIcon size={18} />
          </button>
        </div>
        {loading ? (
          <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" /> Loading…</div>
        ) : !data ? (
          <div className="p-10 text-center text-slate-400 text-sm">Couldn&apos;t load this day.</div>
        ) : (data.lines.length === 0 && data.unitemised.length === 0) ? (
          <div className="p-10 text-center text-slate-400 text-sm">No {isPurchase ? "purchases" : "issues"} recorded on this day.</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200 shrink-0 text-sm">
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Amount</span><b className="tabular-nums">₹{inr(data.totals.amount)}</b></div>
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Qty</span><b className="tabular-nums">{fmtQty(data.totals.qty)}</b></div>
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Lines</span><b className="tabular-nums">{data.totals.lines}</b></div>
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-white sticky top-0 shadow-[0_1px_0_0_#e2e8f0] z-10">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left px-4 py-2">Item</th>
                    <th className="text-left px-2 py-2">Category</th>
                    {isPurchase && <th className="text-left px-2 py-2">Vendor</th>}
                    <th className="text-right px-2 py-2">Qty</th>
                    <th className="text-right px-2 py-2">Rate</th>
                    <th className="text-right px-2 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((r, i) => (
                    <tr key={`${r.item_id}-${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-1.5 font-semibold text-slate-800">{r.name}{r.unit && <span className="text-slate-400 text-xs ml-1">({r.unit})</span>}</td>
                      <td className="px-2 py-1.5 text-slate-500 text-xs">{r.category_label || "—"}</td>
                      {isPurchase && <td className="px-2 py-1.5 text-slate-500 text-xs">{r.vendor || "—"}</td>}
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtQty(r.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.rate ? `₹${inr2(r.rate)}` : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">₹{inr2(r.amount)}</td>
                    </tr>
                  ))}
                  {data.unitemised.map((u, i) => (
                    <tr key={`u-${i}`} className="border-t border-slate-100 bg-amber-50/60">
                      <td className="px-4 py-1.5 italic text-amber-900" colSpan={isPurchase ? 5 : 4}>
                        Bulk-uploaded (no per-item detail) · <b>{u.category_label}</b>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-amber-900">₹{inr2(u.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function firstOfMonthIso(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function addMonthsIso(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  const nd = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  return `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-01`;
}
function monthRange(anchorIso) {
  const d = new Date(anchorIso + "T00:00:00");
  const y = d.getFullYear(), m = d.getMonth();
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return {
    from: fmt(new Date(y, m, 1)),
    to: fmt(new Date(y, m + 1, 0)),
    label: new Date(y, m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

export default function KitchenAnalyticsTab({ liveSig }) {
  // Date scope: a single MONTH (prev / next / this-month nav) or a custom
  // DATE RANGE. (Older All / 7d / 30d / 90d presets were dropped — the
  // pantry is run month-to-month, so a month view + range is what's used.)
  const [mode, setMode] = useState("month");            // "month" | "custom"
  const [monthAnchor, setMonthAnchor] = useState(() => firstOfMonthIso(todayIso()));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // In month mode, from/to track the selected month's first/last day.
  useEffect(() => {
    if (mode !== "month") return;
    const r = monthRange(monthAnchor);
    setFrom(r.from);
    setTo(r.to);
  }, [mode, monthAnchor]);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let ignore = false;
    setLoading(true);
    api.get(`/meals/kitchen-analytics?start=${from}&end=${to}`)
      .then((res) => { if (!ignore) setData(res); })
      .catch((err) => { if (!ignore) showApiError(err, "Couldn't load kitchen analytics"); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [from, to, liveSig]);

  return (
    <div data-testid="kitchen-analytics-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          {[["month", "Month"], ["custom", "Date range"]].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setMode(v)}
              className={`px-3 h-9 text-xs font-bold ${mode === v ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid={`kitchen-analytics-mode-${v}`}
              title={v === "month" ? "View one month at a time" : "Pick a custom start and end date"}
            >{l}</button>
          ))}
        </div>
        {mode === "month" && (
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => setMonthAnchor((a) => addMonthsIso(a, -1))}
              title="Previous month"
              data-testid="kitchen-analytics-prev-month"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            ><ChevronLeft size={16} /></button>
            <div className="min-w-[150px] text-center text-sm font-bold text-slate-700" data-testid="kitchen-analytics-month-label">
              {monthRange(monthAnchor).label}
            </div>
            <button
              onClick={() => setMonthAnchor((a) => addMonthsIso(a, 1))}
              title="Next month"
              data-testid="kitchen-analytics-next-month"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            ><ChevronRight size={16} /></button>
            <button
              onClick={() => setMonthAnchor(firstOfMonthIso(todayIso()))}
              title="Jump to the current month"
              data-testid="kitchen-analytics-this-month"
              className="h-9 px-3 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >This month</button>
          </div>
        )}
        {mode === "custom" && (
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
            from={from} to={to}
            first
          />
          <Section
            title="Issues"
            subtitle="What was issued to the kitchen (valued at weighted-avg purchase rate)"
            accent="issues"
            data={data.issues}
            from={from} to={to}
            testKind="issues"
          />
        </>
      )}
    </div>
  );
}
