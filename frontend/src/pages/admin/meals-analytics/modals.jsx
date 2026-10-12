import React from "react";
import { useEscape } from "../../../hooks/useEscape";
import { X as CloseIcon, Coffee, Loader2, Moon as MoonIcon, Sun as SunIcon, Users } from "lucide-react";
import { api, showApiError } from "../../../api";
import { EVENT_COLORS, SLOT_COLORS, fmt } from "./helpers";

export function DayAttendeesModal({ date, onClose }) {
  useEscape(onClose);
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
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200 shrink-0" data-testid="ma-day-attendees-counts">
              <StatChip icon={Coffee}  label="Breakfast" value={data.counts.breakfast}       tint="text-amber-700"  />
              <StatChip icon={Coffee}  label="Midmorn."  value={data.counts.midmorning || 0} tint="text-yellow-700" />
              <StatChip icon={SunIcon} label="Lunch"     value={data.counts.lunch}           tint="text-orange-700" />
              <StatChip icon={SunIcon} label="Aft. Snack" value={data.counts.snacks || 0}    tint="text-violet-700" />
              <StatChip icon={MoonIcon} label="Dinner"   value={data.counts.dinner}          tint="text-indigo-700" />
              <StatChip icon={Users}   label="Members"   value={data.unique_members}   tint="text-emerald-700" />
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-white sticky top-0 shadow-[0_1px_0_0_#e2e8f0] z-10">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left px-4 py-2">Member</th>
                    <th className="text-left px-2 py-2">Institution</th>
                    <th className="text-center px-2 py-2 w-[44px]" title="Breakfast">BF</th>
                    <th className="text-center px-2 py-2 w-[44px]" title="Midmorning Snack">MM</th>
                    <th className="text-center px-2 py-2 w-[44px]" title="Lunch">L</th>
                    <th className="text-center px-2 py-2 w-[44px]" title="Afternoon Snack">AS</th>
                    <th className="text-center px-2 py-2 w-[44px]" title="Dinner">D</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => (
                    <React.Fragment key={g.cat}>
                      <tr className="bg-slate-100">
                        <td colSpan={7} className="px-4 py-1.5 text-[10px] font-black uppercase tracking-wider text-slate-600">
                          {g.cat} · {g.rows.length}
                        </td>
                      </tr>
                      {g.rows.map((r) => (
                        <tr key={r.user_id} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="px-4 py-1.5 font-semibold text-slate-800">{r.user_name}</td>
                          <td className="px-2 py-1.5 text-slate-500 text-xs">{r.institution || "—"}</td>
                          {[["breakfast", "Breakfast"], ["midmorning", "Midmorning"], ["lunch", "Lunch"], ["snacks", "Snacks"], ["dinner", "Dinner"]].map(([mk, sk]) => (
                            <td key={mk} className="px-2 py-1.5 text-center">{r.meals.includes(mk) ? <MealTick color={SLOT_COLORS[sk]}/> : <Dash/>}</td>
                          ))}
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

export function EventDetailsModal({ kind, ev, onClose }) {
  useEscape(onClose);
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
