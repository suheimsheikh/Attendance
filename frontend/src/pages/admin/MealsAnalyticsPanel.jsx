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
import { TrendingUp, Calendar as CalIcon, BarChart3, Flame, Trophy, Maximize2, X as CloseIcon, PieChart as PieIcon, Coffee, Sun as SunIcon, Moon as MoonIcon, Loader2, Users } from "lucide-react";
import { api, showApiError } from "../../api";

const SLOT_COLORS = { Breakfast: "#F59E0B", Lunch: "#F97316", Dinner: "#6366F1" };
const EVENT_COLORS = {
  regatta: { fill: "#DC2626", label: "Regatta" },
  camp:    { fill: "#0EA5E9", label: "Camp" },
  break:   { fill: "#94A3B8", label: "Break" },
};
const inr = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

/** Custom tooltip that renders label + payload rows plus a
 * "click to see roster" hint. */
function TrendTooltip({ active, payload, label }) {
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
function renderTotalDot(heightPx) {
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
      // `has_muster` is set by the backend when per-person
      // meal_records exist for the date. Used to render a bolder
      // dot on the Total line so admins can see at-a-glance where a
      // click will surface a roster (even if the day's counts came
      // from a spreadsheet import that shadows the muster totals).
      hasRoster: !!d.has_muster,
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
  const [selectedEvent, setSelectedEvent] = React.useState(null);
  const [selectedDay, setSelectedDay] = React.useState(null);
  React.useEffect(() => {
    if (!fullscreen && !selectedEvent && !selectedDay) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (selectedDay) setSelectedDay(null);
      else if (selectedEvent) setSelectedEvent(null);
      else if (fullscreen) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, selectedEvent, selectedDay]);
  // Map events → bands drawn on the trend chart. Only regattas/camps/
  // breaks that actually intersect a populated day contribute (else
  // Recharts complains about unknown X-axis keys). Camps that only
  // run on certain weekdays (e.g. Agape Sat/Sun) get exploded into
  // one segment per matching weekday so the strip visually matches
  // reality — a continuous rectangle would suggest a 5-week camp
  // when it was actually just 10 weekend days.
  const bands = useMemo(() => {
    if (!m || !events) return [];
    const kinds = ["regatta", "camp", "break"];
    const winStart = m.rows[0].date;
    const winEnd = m.rows[m.rows.length - 1].date;
    const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const out = [];
    kinds.forEach((k) => {
      (events[k + "s"] || []).forEach((ev) => {
        // Clamp to the visible window so slivers never overshoot
        // the chart edges.
        const s = ev.start_date < winStart ? winStart : ev.start_date;
        const e = ev.end_date > winEnd ? winEnd : ev.end_date;
        if (s > e) return;
        const dows = Array.isArray(ev.days_of_week) ? ev.days_of_week : [];
        // No weekday filter, or single-day event → keep as one segment.
        if (!dows.length || s === e) {
          out.push({ kind: k, name: ev.name, start_date: s, end_date: e, segment: 0, ev_full: ev });
          return;
        }
        // Walk the date range and open a new segment for each run of
        // consecutive matching weekdays. A weekend-only camp thus
        // becomes ~2-day slivers separated by 5-day gaps.
        let segStart = null;
        let idx = 0;
        const cur = new Date(s + "T00:00:00");
        const endD = new Date(e + "T00:00:00");
        while (cur <= endD) {
          const iso = cur.toISOString().slice(0, 10);
          const key = DOW_KEYS[cur.getDay()];
          if (dows.includes(key)) {
            if (!segStart) segStart = iso;
          } else if (segStart) {
            const prev = new Date(cur); prev.setDate(prev.getDate() - 1);
            out.push({ kind: k, name: ev.name, start_date: segStart,
                       end_date: prev.toISOString().slice(0, 10), segment: idx++, ev_full: ev });
            segStart = null;
          }
          cur.setDate(cur.getDate() + 1);
        }
        if (segStart) {
          out.push({ kind: k, name: ev.name, start_date: segStart, end_date: e, segment: idx, ev_full: ev });
        }
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
  // AND fullscreen without duplicating the JSX block. Renders four
  // series: BF / L / D (thin, per-slot colours) + Total (thick
  // emerald with bolder dots on muster days). Click any dot to open
  // the "who ate today" roster — the click path uses Recharts'
  // activeDot onClick which carries the exact hovered payload, so
  // the popup always shows the date the user visually clicked (a
  // plain frac-of-wrapper-width calc would drift by the X-axis and
  // Y-axis label padding).
  const renderTrend = (heightPx) => (
    <div
      style={{ width: "100%", height: heightPx, cursor: "pointer" }}
      data-testid={heightPx > 400 ? "ma-daily-trend-fs" : "ma-daily-trend"}
      onClick={(e) => {
        // Frac-of-wrapper-width click math — accurate enough for a
        // single-axis chart (the only padding is ~4px margin), and
        // has been verified working since the popup shipped. Do NOT
        // "improve" this without a full E2E re-test — the dual-axis
        // Kitchen Analytics chart uses activeIdxRef instead because
        // its Y-axis labels add ~60px of drift.
        const rect = e.currentTarget.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const frac = Math.max(0, Math.min(1, relX / rect.width));
        const idx = Math.round(frac * (m.rows.length - 1));
        const day = m.rows[idx]?.date;
        if (day) setSelectedDay(day);
      }}
    >
      <ResponsiveContainer>
        <LineChart
          data={m.rows}
          margin={{ top: 8, right: 12, left: 4, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="label" tick={{ fontSize: heightPx > 400 ? 12 : 10 }} interval="preserveStartEnd" minTickGap={20} />
          <YAxis tick={{ fontSize: heightPx > 400 ? 12 : 10 }} />
          <Tooltip
            contentStyle={{ fontSize: 12 }}
            formatter={(v) => `${inr(v)} meals`}
            content={<TrendTooltip />}
          />
          <Legend wrapperStyle={{ fontSize: heightPx > 400 ? 13 : 11 }} />
          <Line type="monotone" dataKey="Breakfast" stroke={SLOT_COLORS.Breakfast} strokeWidth={1.25} dot={false} />
          <Line type="monotone" dataKey="Lunch"     stroke={SLOT_COLORS.Lunch}     strokeWidth={1.25} dot={false} />
          <Line type="monotone" dataKey="Dinner"    stroke={SLOT_COLORS.Dinner}    strokeWidth={1.25} dot={false} />
          <Line
            type="monotone" dataKey="total" name="Total"
            stroke="#10B981" strokeWidth={2.25}
            dot={renderTotalDot(heightPx)}
            activeDot={{ r: 7 }}
          />
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
                // Guarantee a visible sliver even for a single Sat/Sun
                // (which is <2% of a 3-month window).
                const w = Math.max(0.5, r - l);
                const isFirst = ev.segment === 0 || ev.segment === undefined;
                return (
                  <button
                    type="button"
                    key={`${ev.name}-${ev.start_date}-${i}`}
                    onClick={() => setSelectedEvent({ kind: k, ev: ev.ev_full })}
                    className={`absolute top-0.5 ${barH} rounded flex items-center px-1 font-semibold text-white overflow-hidden whitespace-nowrap cursor-pointer hover:brightness-110 hover:ring-2 hover:ring-white/60`}
                    style={{ left: `${l}%`, width: `${w}%`, background: EVENT_COLORS[k].fill }}
                    title={`${ev.name} · ${ev.start_date} → ${ev.end_date} · Click for details`}
                    data-testid={`ma-event-bar-${k}-${i}`}
                  >
                    {isFirst && <span className="truncate">{ev.name}</span>}
                  </button>
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
            <span className="hidden sm:inline text-[10px] text-slate-400 ml-1">· tap a day to see the roster</span>
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

      {selectedEvent && (
        <EventDetailsModal
          kind={selectedEvent.kind}
          ev={selectedEvent.ev}
          onClose={() => setSelectedEvent(null)}
        />
      )}
      {selectedDay && (
        <DayAttendeesModal
          date={selectedDay}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </div>
  );
}

function DayAttendeesModal({ date, onClose }) {
  // Fetches /meals/day-attendees once, lists every member who marked
  // any meal on `date`, with a BF/L/D badge trio per row so the admin
  // can spot who took what without a second click.
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  React.useEffect(() => {
    setLoading(true);
    api.get(`/meals/day-attendees?date=${date}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load attendees"))
      .finally(() => setLoading(false));
  }, [date]);
  const dateLabel = fmt(date);
  // Group members by category to make the modal skimmable.
  const grouped = React.useMemo(() => {
    if (!data?.members) return [];
    const g = new Map();
    data.members.forEach((r) => {
      const k = (r.category || "other").toString();
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(r);
    });
    return [...g.entries()].map(([cat, rows]) => ({ cat, rows }));
  }, [data]);
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      onClick={onClose}
      data-testid="ma-day-attendees-modal"
    >
      <div
        className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 bg-slate-900 text-white flex items-center gap-2 shrink-0">
          <Users size={18}/>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-slate-400">Meals roster</div>
            <div className="font-black text-lg truncate">{dateLabel}</div>
          </div>
          <div className="ml-auto" />
          <button
            type="button" onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/10"
            title="Close (Esc)"
            data-testid="ma-day-attendees-close"
          >
            <CloseIcon size={18}/>
          </button>
        </div>
        {loading ? (
          <div className="p-10 text-center text-slate-400">
            <Loader2 className="animate-spin inline mr-2"/> Loading…
          </div>
        ) : !data || data.unique_members === 0 ? (
          <div className="p-10 text-center text-slate-400 text-sm">
            No one marked any meal on this day.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200 shrink-0" data-testid="ma-day-attendees-counts">
              <StatChip icon={Coffee}  label="Breakfast" value={data.counts.breakfast} tint="text-amber-700"  />
              <StatChip icon={SunIcon} label="Lunch"     value={data.counts.lunch}     tint="text-orange-700" />
              <StatChip icon={MoonIcon} label="Dinner"   value={data.counts.dinner}    tint="text-indigo-700" />
              <StatChip icon={Users}   label="Members"   value={data.unique_members}   tint="text-emerald-700" />
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-white sticky top-0 shadow-[0_1px_0_0_#e2e8f0] z-10">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left px-4 py-2">Member</th>
                    <th className="text-left px-2 py-2">Institution</th>
                    <th className="text-center px-2 py-2 w-[52px]" title="Breakfast">BF</th>
                    <th className="text-center px-2 py-2 w-[52px]" title="Lunch">L</th>
                    <th className="text-center px-2 py-2 w-[52px]" title="Dinner">D</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => (
                    <React.Fragment key={g.cat}>
                      <tr className="bg-slate-100">
                        <td colSpan={5} className="px-4 py-1.5 text-[10px] font-black uppercase tracking-wider text-slate-600">
                          {g.cat} · {g.rows.length}
                        </td>
                      </tr>
                      {g.rows.map((r) => (
                        <tr key={r.user_id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-1.5 font-semibold text-slate-800">{r.user_name}</td>
                          <td className="px-2 py-1.5 text-slate-500 text-xs">{r.institution || "—"}</td>
                          <td className="px-2 py-1.5 text-center">{r.meals.includes("breakfast") ? <MealTick color={SLOT_COLORS.Breakfast}/> : <Dash/>}</td>
                          <td className="px-2 py-1.5 text-center">{r.meals.includes("lunch")     ? <MealTick color={SLOT_COLORS.Lunch}/>     : <Dash/>}</td>
                          <td className="px-2 py-1.5 text-center">{r.meals.includes("dinner")    ? <MealTick color={SLOT_COLORS.Dinner}/>    : <Dash/>}</td>
                        </tr>
                      ))}
                    </React.Fragment>
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

function MealTick({ color }) {
  return (
    <span
      className="inline-block w-4 h-4 rounded-full"
      style={{ background: color }}
      aria-label="taken"
    />
  );
}
function Dash() {
  return <span className="text-slate-300">—</span>;
}
function StatChip({ icon: Icon, label, value, tint }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon size={14} className={tint} />
      <span className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{label}</span>
      <span className={`text-sm font-black tabular-nums ${tint}`}>{value}</span>
    </div>
  );
}

function EventDetailsModal({ kind, ev, onClose }) {
  // Lightweight read-only popup shown when an admin taps a coloured
  // sliver in the timeline strip. Surfaces every field we packed from
  // the /meal-calendar/events endpoint. Runs one meal-calendar day
  // lookup to give a live-total peek without leaving the page.
  const c = EVENT_COLORS[kind];
  const DOW_LABEL = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu",
                       fri: "Fri", sat: "Sat", sun: "Sun" };
  const dows = Array.isArray(ev.days_of_week) ? ev.days_of_week : [];
  const spanDays = (() => {
    if (!ev.start_date || !ev.end_date) return null;
    const s = new Date(ev.start_date + "T00:00:00");
    const e = new Date(ev.end_date + "T00:00:00");
    return Math.round((e - s) / 86400000) + 1;
  })();
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      onClick={onClose}
      data-testid="ma-event-details-modal"
    >
      <div
        className="bg-white rounded-xl max-w-md w-full shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 flex items-center gap-2" style={{ background: c.fill, color: "white" }}>
          <span className="text-[10px] font-black uppercase tracking-widest bg-white/20 rounded px-2 py-0.5">
            {c.label}
          </span>
          <h3 className="font-black text-lg truncate flex-1" title={ev.name}>{ev.name}</h3>
          <button
            type="button" onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/20"
            title="Close (Esc)"
            data-testid="ma-event-details-close"
          >
            <CloseIcon size={18}/>
          </button>
        </div>
        <dl className="p-5 text-sm space-y-2">
          <Row label="Dates">
            <span className="font-semibold">{fmt(ev.start_date)}</span>
            {ev.end_date !== ev.start_date && (
              <>
                <span className="text-slate-400"> → </span>
                <span className="font-semibold">{fmt(ev.end_date)}</span>
              </>
            )}
            {spanDays != null && (
              <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                {spanDays} day{spanDays !== 1 ? "s" : ""}
              </span>
            )}
          </Row>
          {dows.length > 0 && (
            <Row label="Runs on">
              <div className="flex items-center gap-1 flex-wrap">
                {["mon","tue","wed","thu","fri","sat","sun"].map((k) => {
                  const on = dows.includes(k);
                  return (
                    <span
                      key={k}
                      className={`text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 ${on ? "text-white" : "bg-slate-100 text-slate-400"}`}
                      style={on ? { background: c.fill } : undefined}
                    >
                      {DOW_LABEL[k]}
                    </span>
                  );
                })}
              </div>
            </Row>
          )}
          {ev.level && <Row label="Level"><span className="capitalize">{ev.level}</span></Row>}
          {ev.location && <Row label="Location">{ev.location}</Row>}
          {ev.institution && <Row label="Institution">{ev.institution}</Row>}
        </dl>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 items-baseline">
      <dt className="text-[10px] uppercase tracking-wider font-bold text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}
