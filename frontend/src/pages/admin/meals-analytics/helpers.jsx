import { useMemo } from "react";

export const SLOT_KEYS = ["Breakfast", "Midmorning", "Lunch", "Snacks", "Dinner"];
export const SLOT_COLORS = { Breakfast: "#F59E0B", Midmorning: "#EAB308", Lunch: "#F97316", Snacks: "#8B5CF6", Dinner: "#6366F1" };
export const slotMix = (slots) => slots.map((s) => s.pct).join("·") + "%";
export const EVENT_COLORS = {
  regatta: { fill: "#DC2626", label: "Regatta" },
  camp:    { fill: "#0EA5E9", label: "Camp" },
  break:   { fill: "#94A3B8", label: "Break" },
};
export const inr = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

/** Custom tooltip that renders label + payload rows plus a
 * "click to see roster" hint. */
export function TrendTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-md shadow px-2 py-1.5 text-xs">
      <div className="font-bold text-slate-800 mb-0.5">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
          <span className="text-slate-500">{p.name}</span>
          <span className="tabular-nums font-semibold text-slate-800 ml-auto">{inr(p.value)}</span>
        </div>
      ))}
      <div className="text-[10px] text-slate-400 mt-1">Click to see roster</div>
    </div>
  );
}

/** Returns a Recharts <Line dot> renderer that draws a bolder filled
 * emerald circle on days with per-person meal_records (source ===
 * "muster") and a smaller hollow dot otherwise — signposts where a
 * click will surface the "who ate today" roster. */
export function renderTotalDot(heightPx) {
  return function TotalDot(props) {
    const { cx, cy, payload, index } = props;
    if (cx == null || cy == null) return null;
    const roster = !!payload?.hasRoster;
    // Aggregate-only days: no dot at all — keeps the line clean and
    // makes the roster days stand out even more.
    if (!roster) return null;
    const r = heightPx > 400 ? 6 : 4.5;
    return (
      <g key={`total-dot-${index}`}>
        {/* Soft halo so the marker reads even against the coloured
            BF/L/D lines beneath it. */}
        <circle cx={cx} cy={cy} r={r + 2.5} fill="#10B981" opacity={0.18} />
        <circle
          cx={cx} cy={cy} r={r}
          fill="#10B981"
          stroke="#ffffff"
          strokeWidth={1.75}
        />
      </g>
    );
  };
}


const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmt(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

export function useMetrics(days) {
  return useMemo(() => {
    const populated = (days || []).filter((d) => d.has_data);
    if (populated.length === 0) return null;

    // ── Daily series ─────────────────────────────────────────────
    const rows = populated.map((d) => ({
      date: d.date,
      label: fmt(d.date),
      Breakfast: d.breakfast || 0,
      Midmorning: d.midmorning || 0,
      Lunch: d.lunch || 0,
      Snacks: d.snacks || 0,
      Dinner: d.dinner || 0,
      total: d.total,
      dow: new Date(d.date + "T00:00:00").getDay(),
      // `has_muster` is set by the backend when per-person
      // meal_records exist for the date. Used to render a bolder
      // dot on the Total line so admins can see at-a-glance where a
      // click will surface a roster (even if the day's counts came
      // from a spreadsheet import that shadows the muster totals).
      hasRoster: !!d.has_muster,
    }));

    // ── Meal-slot totals ──────────────────────────────────────────
    const sums = Object.fromEntries(SLOT_KEYS.map((k) => [k, rows.reduce((s, r) => s + r[k], 0)]));
    const grand = SLOT_KEYS.reduce((s, k) => s + sums[k], 0);
    const slots = SLOT_KEYS.map((k) => ({
      key: k, value: sums[k], pct: grand ? Math.round(sums[k] * 100 / grand) : 0,
    }));

    // ── Day-of-week averages (per meal-slot separately) ──────────
    const emptySlots = () => Object.fromEntries(SLOT_KEYS.map((k) => [k, 0]));
    const dowAgg = Array(7).fill(0).map(() => ({ ...emptySlots(), days: 0 }));
    rows.forEach((r) => {
      SLOT_KEYS.forEach((k) => { dowAgg[r.dow][k] += r[k]; });
      dowAgg[r.dow].days += 1;
    });
    // Present as Mon-first order with each meal averaged over the
    // count of days-of-that-weekday actually present in the window.
    const dowRows = [1, 2, 3, 4, 5, 6, 0].map((i) => {
      const n = dowAgg[i].days || 1;
      const row = { dow: DOW[i], days: dowAgg[i].days };
      let daySum = 0;
      SLOT_KEYS.forEach((k) => { row[k] = Math.round(dowAgg[i][k] / n); daySum += dowAgg[i][k]; });
      row.avg = Math.round(daySum / n);
      return row;
    });

    // ── Monthly totals ────────────────────────────────────────────
    const monthMap = new Map();
    rows.forEach((r) => {
      const [y, m] = r.date.split("-");
      const key = `${MONTH_LABELS[+m - 1]} ${y}`;
      const rec = monthMap.get(key) || { month: key, ...emptySlots(), days: 0 };
      SLOT_KEYS.forEach((k) => { rec[k] += r[k]; });
      rec.days += 1;
      monthMap.set(key, rec);
    });
    const months = [...monthMap.values()];

    // ── Peaks ─────────────────────────────────────────────────────
    const sorted = [...rows].sort((a, b) => b.total - a.total);
    const highest = sorted[0];
    const lowest = sorted[sorted.length - 1];

    return {
      rows, slots, dowRows, months, highest, lowest,
      totals: { ...sums, grand, days: rows.length,
                avgPerDay: rows.length ? Math.round(grand / rows.length) : 0 },
    };
  }, [days]);
}

export function StatPill({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card !py-1.5 !px-2.5 flex items-center gap-2 ${tint || ""}`}>
      <Icon size={13} className="shrink-0 opacity-70" />
      <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 whitespace-nowrap">{label}</div>
      <div className="ml-auto text-xs font-black tabular-nums truncate">{value}</div>
    </div>
  );
}
