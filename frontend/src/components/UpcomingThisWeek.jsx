import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarDays, ChevronDown, ChevronUp, Tent, Sailboat, Coffee } from "lucide-react";
import { api } from "../api";

// Local YYYY-MM-DD (not UTC) — comparison must match what backend stores.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function shortDate(s) {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  const dt = new Date(Number(y), Number(m) - 1, Number(d));
  return dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const REGATTA_LEVEL_TONE = {
  international: "bg-violet-100 text-violet-700 border-violet-200",
  national:      "bg-amber-100 text-amber-800 border-amber-200",
  state:         "bg-sky-100 text-sky-700 border-sky-200",
  club:          "bg-slate-100 text-slate-700 border-slate-200",
};

const BREAK_SCOPE_LABEL = {
  all: "Everyone", athletes: "All athletes", coaches: "All coaches",
  staff: "All staff", institution: "Institution", selected: "Selected",
};

/**
 * Collapsible "what's coming up in the next 7 days" strip — surfaces every
 * camp, break, and regatta active or starting soon. Closed by default to
 * keep the Presence Board lean; opens when the admin or coach wants context.
 */
export default function UpcomingThisWeek() {
  const [open, setOpen] = useState(false);
  const [camps, setCamps] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [regattas, setRegattas] = useState([]);

  useEffect(() => {
    api.get("/camps").then((r) => setCamps(r || [])).catch(() => {});
    api.get("/breaks").then((r) => setBreaks(r || [])).catch(() => {});
    api.get("/regattas").then((r) => setRegattas(r || [])).catch(() => {});
  }, []);

  const upcoming = useMemo(() => {
    const today = ymd(new Date());
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 7);
    const horizonStr = ymd(horizon);
    const inWindow = (start, end) =>
      (start <= today && end >= today) ||
      (start > today && start <= horizonStr);
    const items = [];
    for (const c of camps) {
      if (inWindow(c.start_date, c.end_date)) items.push({ kind: "camp", id: c.id, name: c.name, start: c.start_date, end: c.end_date, raw: c });
    }
    for (const b of breaks) {
      if (inWindow(b.start_date, b.end_date)) items.push({ kind: "break", id: b.id, name: b.name, start: b.start_date, end: b.end_date, raw: b });
    }
    for (const r of regattas) {
      if (inWindow(r.start_date, r.end_date)) items.push({ kind: "regatta", id: r.id, name: r.name, start: r.start_date, end: r.end_date, raw: r });
    }
    items.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    return items;
  }, [camps, breaks, regattas]);

  if (upcoming.length === 0) return null;

  return (
    <div className="iu-card mb-4 border-2 border-sky-200 bg-sky-50/40" data-testid="upcoming-strip">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-sky-50 rounded-2xl transition"
        data-testid="upcoming-toggle"
        aria-expanded={open}
      >
        <div className="w-9 h-9 rounded-lg bg-sky-600 text-white flex items-center justify-center shrink-0 shadow-sm">
          <CalendarDays size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-extrabold text-slate-900 text-sm leading-tight">Coming up this week</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {upcoming.length} event{upcoming.length === 1 ? "" : "s"} active or starting in the next 7 days
          </div>
        </div>
        {open ? <ChevronUp size={18} className="text-sky-700 shrink-0" /> : <ChevronDown size={18} className="text-sky-700 shrink-0" />}
      </button>
      {open && (
        <div className="px-3 pb-3 flex gap-2 overflow-x-auto">
          {upcoming.map((e) => (
            <UpcomingChip key={`${e.kind}-${e.id}`} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function UpcomingChip({ entry }) {
  const { kind, name, start, end, raw } = entry;
  const today = ymd(new Date());
  const isLive = start <= today && end >= today;
  const rangeLabel = start === end ? shortDate(start) : `${shortDate(start)} → ${shortDate(end)}`;

  let Icon, toneClasses, kindLabel, extra;
  if (kind === "camp") {
    Icon = Tent;
    toneClasses = "bg-emerald-50 border-emerald-200 text-emerald-900";
    kindLabel = "Camp";
    extra = raw.start_time ? `${raw.start_time}–${raw.end_time}` : null;
  } else if (kind === "break") {
    Icon = Coffee;
    toneClasses = "bg-amber-50 border-amber-200 text-amber-900";
    kindLabel = "Break";
    extra = BREAK_SCOPE_LABEL[raw.scope] || null;
  } else {
    Icon = Sailboat;
    const tone = REGATTA_LEVEL_TONE[raw.level] || REGATTA_LEVEL_TONE.club;
    toneClasses = `bg-white ${tone}`;
    kindLabel = (raw.level || "Regatta").replace(/^\w/, (c) => c.toUpperCase());
    extra = raw.location || null;
  }

  return (
    <Link
      to="/admin/calendar"
      className={`shrink-0 min-w-[180px] max-w-[220px] rounded-lg border px-3 py-2 hover:shadow-sm transition ${toneClasses}`}
      data-testid={`upcoming-${kind}-${entry.id}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={12} />
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{kindLabel}</span>
        {isLive && <span className="ml-auto text-[9px] font-extrabold px-1.5 rounded bg-red-600 text-white">LIVE</span>}
      </div>
      <div className="text-sm font-bold truncate mt-1" title={name}>{name}</div>
      <div className="text-[10px] opacity-75 truncate">{rangeLabel}</div>
      {extra && <div className="text-[10px] opacity-60 truncate">{extra}</div>}
    </Link>
  );
}
