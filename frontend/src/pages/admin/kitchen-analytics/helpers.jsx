import { InfoTip } from "../../../components/InfoTip";
import { fmtQty as uQty } from "../../../utils";

// Same palette + a deterministic (item_id → colour) mapping so the
// same item paints in the same colour across ALL charts on this
// screen (Top items by ₹, Top items by qty, focused Daily-trend).
export const CHART_COLORS = [
  "#2563EB", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
  "#0EA5E9", "#DB2777",
];

// Deterministic (item_id → colour) mapping. Uses a tiny string hash
// so "Rice" is always the same colour across every chart on the
// screen without needing a shared React context. Same UUID → same
// palette index → same colour, session after session.
export function colorForItem(id) {
  if (!id) return CHART_COLORS[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h * 31) + id.charCodeAt(i)) >>> 0;
  return CHART_COLORS[h % CHART_COLORS.length];
}

export const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const inr2 = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtQty = (n, unit) =>
  n == null ? "—" : uQty(n, unit);

export function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function StatPill({ icon: Icon, label, value, tint, hint }) {
  return (
    <div className={`iu-card p-3 flex items-center gap-3 ${tint || ""}`}>
      <div className="w-9 h-9 rounded-lg bg-white/70 flex items-center justify-center shrink-0">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 inline-flex items-center gap-1">
          {label}
          {hint && <InfoTip text={hint} size={11} />}
        </div>
        <div className="text-lg font-extrabold tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

export function BannerStat({ icon: Icon, label, value, hint }) {
  // Chip variant of StatPill rendered INSIDE the coloured banner.
  // Uses translucent white for readable contrast on both the blue
  // (Purchases) and orange (Consumption) bands.
  return (
    <div className="rounded-lg bg-white/15 backdrop-blur-sm px-3 py-2 flex items-center gap-2.5 min-w-0">
      <div className="w-8 h-8 rounded-md bg-white/25 flex items-center justify-center shrink-0">
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider font-bold opacity-80 inline-flex items-center gap-1">
          {label}
          {hint && <InfoTip text={hint} size={11} iconClassName="text-white/80" />}
        </div>
        <div className="text-base sm:text-lg font-black tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

export function makeDotRenderer(seriesKey, color, fullscreen) {
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
export function buildWeeklyMonthly(daily, catKeys) {
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
