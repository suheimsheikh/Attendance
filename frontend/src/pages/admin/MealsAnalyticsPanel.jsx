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
import { BarChart3, Calendar as CalIcon, X as CloseIcon, Flame, Maximize2, PieChart as PieIcon, TrendingUp, Trophy } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatDate, addDaysIso } from "../../utils";
import { EVENT_COLORS, SLOT_COLORS, SLOT_KEYS, StatPill, TrendTooltip, fmt, inr, renderTotalDot, slotMix, useMetrics } from "./meals-analytics/helpers";
import { DayAttendeesModal, EventDetailsModal } from "./meals-analytics/modals";


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
        for (let iso = s; iso <= e; iso = addDaysIso(iso, 1)) {
          const key = DOW_KEYS[new Date(iso + "T00:00:00").getDay()];
          if (dows.includes(key)) {
            if (!segStart) segStart = iso;
          } else if (segStart) {
            out.push({ kind: k, name: ev.name, start_date: segStart,
                       end_date: addDaysIso(iso, -1), segment: idx++, ev_full: ev });
            segStart = null;
          }
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
        // Map click X-position to a data index using the ACTUAL
        // plot-area rectangle (not the wrapper's) so we don't drift
        // by the left Y-axis label width. Recharts renders the plot
        // exactly at `.recharts-cartesian-grid`; reading its
        // bounding box gives us the correct-by-construction bounds.
        const grid = e.currentTarget.querySelector(".recharts-cartesian-grid");
        const rect = grid?.getBoundingClientRect
          ? grid.getBoundingClientRect()
          : e.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
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
          {SLOT_KEYS.map((k) => (
            <Line key={k} type="monotone" dataKey={k} stroke={SLOT_COLORS[k]} strokeWidth={1.25} dot={false} />
          ))}
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
                    title={`${ev.name} · ${formatDate(ev.start_date)} → ${formatDate(ev.end_date)} · Click for details`}
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
        <StatPill icon={PieIcon} label="BF : MM : L : AS : D"
                  value={slotMix(m.slots)}
                  tint="bg-violet-50" />
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Daily meals · per slot · Total</div>
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
          <p className="text-[11px] leading-snug text-slate-500 mb-2">
            Meals served each day, split by slot (Breakfast, Lunch, Dinner &amp; snacks) with a bold Total line.
            A filled dot marks days recorded via per-person Meal Muster; days from spreadsheet imports have no dot.
            Coloured bands under the chart mark camps &amp; regattas. Tap any Total dot to see who ate that day.
          </p>
          {renderTrend(320)}
          {renderEventStrip(true)}
        </div>

        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Average meals by day of week</div>
            <span className="text-[10px] text-slate-400">(per-slot split)</span>
          </div>
          <p className="text-[11px] leading-snug text-slate-500 mb-2">
            The average number of meals served on each weekday across the selected range — useful for spotting
            quieter days (e.g. Sundays) so the kitchen can plan portions and reduce waste.
          </p>
          <div style={{ width: "100%", height: 320 }} data-testid="ma-dow-bar">
            <ResponsiveContainer>
              <BarChart data={m.dowRows} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="dow" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${inr(v)} avg`, n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {SLOT_KEYS.map((k) => (
                  <Bar key={k} dataKey={k} fill={SLOT_COLORS[k]} radius={[3, 3, 0, 0]} />
                ))}
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
            <h2 className="font-black text-xl">Daily meals · per slot · Total</h2>
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
            <StatPill icon={PieIcon} label="BF : MM : L : AS : D" value={slotMix(m.slots)} tint="bg-violet-50" />
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
