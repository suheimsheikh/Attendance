/**
 * MealsAnalyticsPanel — two charts derived entirely client-side from
 * the `days` array the Meals Calendar already fetches. Purposefully no
 * extra API call: the compute is trivial and the charts stay in sync
 * with any inline edit the admin makes.
 *
 *   • Daily meals + 7-day moving-average (line chart, fullscreen-able)
 *   • Day-of-week average — BF / L / D (grouped bar)
 */
import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, BarChart, Bar,
} from "recharts";
import { TrendingUp, Calendar as CalIcon, BarChart3, Flame, Trophy, Maximize2, X as CloseIcon, PieChart as PieIcon } from "lucide-react";

const SLOT_COLORS = { Breakfast: "#F59E0B", Lunch: "#F97316", Dinner: "#6366F1" };
const EVENT_COLORS = {
  regatta: { fill: "#DC2626", label: "Regatta" },
  camp:    { fill: "#0EA5E9", label: "Camp" },
  break:   { fill: "#94A3B8", label: "Break" },
};
const inr = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

function useMetrics(days) {
  return useMemo(() => {
    const populated = (days || []).filter((d) => d.has_data);
    if (populated.length === 0) return null;

    // ── Daily series ─────────────────────────────────────────────
    const rows = populated.map((d) => ({
      date: d.date,
      label: fmt(d.date),
      Breakfast: d.breakfast,
      Lunch: d.lunch,
      Dinner: d.dinner,
      total: d.total,
      dow: new Date(d.date + "T00:00:00").getDay(),
    }));

    // ── Meal-slot totals ──────────────────────────────────────────
    const bf = rows.reduce((s, r) => s + r.Breakfast, 0);
    const l  = rows.reduce((s, r) => s + r.Lunch, 0);
    const dn = rows.reduce((s, r) => s + r.Dinner, 0);
    const grand = bf + l + dn;
    const slots = [
      { key: "Breakfast", value: bf, pct: grand ? Math.round(bf * 100 / grand) : 0 },
      { key: "Lunch",     value: l,  pct: grand ? Math.round(l  * 100 / grand) : 0 },
      { key: "Dinner",    value: dn, pct: grand ? Math.round(dn * 100 / grand) : 0 },
    ];

    // ── Day-of-week averages (per meal-slot separately) ──────────
    const dowAgg = Array(7).fill(0).map(() => ({
      Breakfast: 0, Lunch: 0, Dinner: 0, days: 0,
    }));
    rows.forEach((r) => {
      dowAgg[r.dow].Breakfast += r.Breakfast;
      dowAgg[r.dow].Lunch     += r.Lunch;
      dowAgg[r.dow].Dinner    += r.Dinner;
      dowAgg[r.dow].days += 1;
    });
    // Present as Mon-first order with each meal averaged over the
    // count of days-of-that-weekday actually present in the window.
    const dowRows = [1, 2, 3, 4, 5, 6, 0].map((i) => {
      const n = dowAgg[i].days || 1;
      return {
        dow: DOW[i],
        Breakfast: Math.round(dowAgg[i].Breakfast / n),
        Lunch:     Math.round(dowAgg[i].Lunch / n),
        Dinner:    Math.round(dowAgg[i].Dinner / n),
        days:      dowAgg[i].days,
        avg:       Math.round((dowAgg[i].Breakfast + dowAgg[i].Lunch + dowAgg[i].Dinner) / n),
      };
    });

    // ── Monthly totals ────────────────────────────────────────────
    const monthMap = new Map();
    rows.forEach((r) => {
      const [y, m] = r.date.split("-");
      const key = `${MONTH_LABELS[+m - 1]} ${y.slice(-2)}`;
      const rec = monthMap.get(key) || { month: key, Breakfast: 0, Lunch: 0, Dinner: 0, days: 0 };
      rec.Breakfast += r.Breakfast;
      rec.Lunch     += r.Lunch;
      rec.Dinner    += r.Dinner;
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
      totals: { Breakfast: bf, Lunch: l, Dinner: dn, grand, days: rows.length,
                avgPerDay: rows.length ? Math.round(grand / rows.length) : 0 },
    };
  }, [days]);
}

function StatPill({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card !py-1.5 !px-2.5 flex items-center gap-2 ${tint || ""}`}>
      <Icon size={13} className="shrink-0 opacity-70" />
      <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 whitespace-nowrap">{label}</div>
      <div className="ml-auto text-xs font-black tabular-nums truncate">{value}</div>
    </div>
  );
}

export default function MealsAnalyticsPanel({ days, events }) {
  const m = useMetrics(days);
  const [fullscreen, setFullscreen] = React.useState(false);
  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);
  // Map events → bands drawn on the trend chart. Only regattas/camps/
  // breaks that actually intersect a populated day contribute (else
  // Recharts complains about unknown X-axis keys).
  const bands = useMemo(() => {
    if (!m || !events) return [];
    const kinds = ["regatta", "camp", "break"];
    const out = [];
    kinds.forEach((k) => {
      (events[k + "s"] || []).forEach((ev) => {
        // Clamp to the visible window so the strip never overshoots
        // the chart edges.
        const winStart = m.rows[0].date;
        const winEnd = m.rows[m.rows.length - 1].date;
        const s = ev.start_date < winStart ? winStart : ev.start_date;
        const e = ev.end_date > winEnd ? winEnd : ev.end_date;
        if (s > e) return;
        out.push({ kind: k, name: ev.name, start_date: s, end_date: e });
      });
    });
    return out;
  }, [m, events]);
  if (!m) {
    return (
      <div className="iu-card p-6 text-center text-slate-400 text-sm" data-testid="meals-analytics-empty">
        No populated days in this window to analyse.
      </div>
    );
  }
  // Trend chart body factored out so we can render it inside the card
  // AND fullscreen without duplicating the ~30-line JSX block.
  // Renders four series: BF / L / D (thin, per-slot colours) + Total
  // (thick emerald) + 7-day MA (dashed slate). BF/L/D can be toggled
  // off via the Legend if the admin wants a clean Total view.
  const renderTrend = (heightPx) => (
    <div style={{ width: "100%", height: heightPx }} data-testid={heightPx > 400 ? "ma-daily-trend-fs" : "ma-daily-trend"}>
      <ResponsiveContainer>
        <LineChart data={m.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: heightPx > 400 ? 12 : 10 }} interval="preserveStartEnd" minTickGap={20} />
          <YAxis tick={{ fontSize: heightPx > 400 ? 12 : 10 }} />
          <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${inr(v)} meals`} />
          <Legend wrapperStyle={{ fontSize: heightPx > 400 ? 13 : 11 }} />
          <Line type="monotone" dataKey="Breakfast" stroke={SLOT_COLORS.Breakfast} strokeWidth={1.25} dot={false} />
          <Line type="monotone" dataKey="Lunch"     stroke={SLOT_COLORS.Lunch}     strokeWidth={1.25} dot={false} />
          <Line type="monotone" dataKey="Dinner"    stroke={SLOT_COLORS.Dinner}    strokeWidth={1.25} dot={false} />
          <Line type="monotone" dataKey="total"     name="Total" stroke="#10B981" strokeWidth={2.25} dot={{ r: heightPx > 400 ? 3 : 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );

  // Thin horizontal Gantt-like strip drawn UNDER the chart. Each event
  // type gets its own row (Regatta / Camp / Break) so overlapping
  // regattas + camps + breaks don't obscure one another. Positions are
  // computed as a % of the visible date-window so the strip aligns to
  // the chart's X-axis without any Recharts coupling.
  const renderEventStrip = (compact = true) => {
    if (!bands.length) return null;
    const startD = new Date(m.rows[0].date + "T00:00:00");
    const endD = new Date(m.rows[m.rows.length - 1].date + "T00:00:00");
    const totalDays = Math.max(1, (endD - startD) / 86400000 + 1);
    const pct = (iso) => {
      const d = new Date(iso + "T00:00:00");
      const daysFromStart = (d - startD) / 86400000;
      return Math.max(0, Math.min(100, (daysFromStart / totalDays) * 100));
    };
    const rowFor = (k) => bands.filter((b) => b.kind === k);
    const kinds = ["regatta", "camp", "break"].filter((k) => rowFor(k).length);
    const barH = compact ? "h-3" : "h-4";
    const rowH = compact ? "h-4" : "h-5";
    const gutterCls = compact ? "text-[10px]" : "text-[11px]";
    return (
      <div className={`mt-2 space-y-1 ${gutterCls}`} data-testid="ma-event-strip">
        {kinds.map((k) => (
          <div key={k} className={`flex items-center gap-2`}>
            <div className="w-14 shrink-0 font-bold uppercase tracking-wider text-[9px]" style={{ color: EVENT_COLORS[k].fill }}>
              {EVENT_COLORS[k].label}
            </div>
            <div className={`relative flex-1 ${rowH} bg-slate-50 rounded`}>
              {rowFor(k).map((ev, i) => {
                const l = pct(ev.start_date);
                const r = pct(ev.end_date);
                const w = Math.max(0.7, r - l);
                return (
                  <div
                    key={`${ev.name}-${ev.start_date}-${i}`}
                    className={`absolute top-0.5 ${barH} rounded flex items-center px-1 font-semibold text-white overflow-hidden whitespace-nowrap`}
                    style={{ left: `${l}%`, width: `${w}%`, background: EVENT_COLORS[k].fill }}
                    title={`${ev.name} · ${ev.start_date} → ${ev.end_date}`}
                    data-testid={`ma-event-bar-${k}-${i}`}
                  >
                    <span className="truncate">{ev.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const eventLegend = bands.length > 0 && (
    <div className="flex items-center gap-2 text-[10px]">
      {["regatta", "camp", "break"].map((k) => bands.some((b) => b.kind === k) && (
        <span key={k} className="inline-flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: EVENT_COLORS[k].fill }} />
          <span className="text-slate-500">{EVENT_COLORS[k].label}</span>
        </span>
      ))}
    </div>
  );

  return (
    <div className="space-y-3" data-testid="meals-analytics-panel">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatPill icon={Flame}  label="Avg meals / day" value={inr(m.totals.avgPerDay)} tint="bg-emerald-50" />
        <StatPill icon={Trophy} label="Highest day"
                  value={`${inr(m.highest.total)} · ${fmt(m.highest.date)}`}
                  tint="bg-amber-50" />
        <StatPill icon={CalIcon} label="Days populated" value={m.totals.days} tint="bg-sky-50" />
        <StatPill icon={PieIcon} label="BF : L : D"
                  value={`${m.slots[0].pct}·${m.slots[1].pct}·${m.slots[2].pct}%`}
                  tint="bg-violet-50" />
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Daily meals · BF · L · D · Total</div>
            {bands.length > 0 && <div className="ml-auto">{eventLegend}</div>}
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
              title="Expand to full screen"
              data-testid="ma-daily-trend-fullscreen"
            >
              <Maximize2 size={14}/>
            </button>
          </div>
          {renderTrend(320)}
          {renderEventStrip(true)}
        </div>

        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Average meals by day of week</div>
            <span className="text-[10px] text-slate-400">(BF · L · D split)</span>
          </div>
          <div style={{ width: "100%", height: 320 }} data-testid="ma-dow-bar">
            <ResponsiveContainer>
              <BarChart data={m.dowRows} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="dow" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${inr(v)} avg`, n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Breakfast" fill={SLOT_COLORS.Breakfast} radius={[3, 3, 0, 0]} />
                <Bar dataKey="Lunch"     fill={SLOT_COLORS.Lunch}     radius={[3, 3, 0, 0]} />
                <Bar dataKey="Dinner"    fill={SLOT_COLORS.Dinner}    radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-white p-4 sm:p-6 flex flex-col"
          role="dialog"
          onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
          data-testid="ma-daily-trend-fs-modal"
        >
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-emerald-600"/>
            <h2 className="font-black text-xl">Daily meals · BF · L · D · Total</h2>
            {bands.length > 0 && <div className="ml-4">{eventLegend}</div>}
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 !min-h-[44px] !min-w-[44px]"
              title="Close (Esc)"
              data-testid="ma-fullscreen-close"
            >
              <CloseIcon size={18}/>
            </button>
          </div>
          {/* Compact stat strip inside the fullscreen view so the admin
              can read peaks / totals without having to close the modal. */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-3" data-testid="ma-fs-stats">
            <StatPill icon={Flame}   label="Avg / day"     value={inr(m.totals.avgPerDay)} tint="bg-emerald-50" />
            <StatPill icon={Trophy}  label="Highest"       value={`${inr(m.highest.total)} · ${fmt(m.highest.date)}`} tint="bg-amber-50" />
            <StatPill icon={CalIcon} label="Lowest"        value={`${inr(m.lowest.total)} · ${fmt(m.lowest.date)}`} tint="bg-rose-50" />
            <StatPill icon={CalIcon} label="Days"          value={m.totals.days} tint="bg-sky-50" />
            <StatPill icon={PieIcon} label="Grand total"   value={inr(m.totals.grand)} tint="bg-slate-50" />
            <StatPill icon={PieIcon} label="BF : L : D"    value={`${m.slots[0].pct}·${m.slots[1].pct}·${m.slots[2].pct}%`} tint="bg-violet-50" />
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0">
              {renderTrend(Math.max(320, window.innerHeight - 280))}
            </div>
            {renderEventStrip(false)}
          </div>
        </div>
      )}
    </div>
  );
}
