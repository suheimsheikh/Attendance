import { useMemo, useState } from "react";
import { ListOrdered } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate } from "../../../utils";
import { CHART_COLORS, buildWeeklyMonthly, colorForItem, fmtQty, inr, inr2, makeDotRenderer } from "./helpers";

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

export function DailyTrendChart({ data, colorAmt, categoryTotals, testid, onDayClick, height = 260, fullscreen = false, focusSeries, from, to }) {
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

export function TopItemsChart({ items, dataKey, label, testid, showUnit, onToggleItem, focusedIds }) {
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

export function CategoryPie({ rows, testid }) {
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

export function TopVendorsChart({ vendors, testid }) {
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

export function ItemsTable({ items, kind, testid }) {
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
