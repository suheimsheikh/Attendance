import React, { useEffect, useMemo, useState } from "react";
import { Users, CalendarCheck2, Plane, Clock, ShieldCheck, ArrowRight, AlertTriangle, ChevronRight, Calendar, ClipboardCheck, ClipboardList, Building2, IdCard, Building, FileBarChart2, Tent, Sailboat, Coffee, CalendarDays } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api";

// Date helpers — keep YYYY-MM-DD strings so we can compare lexicographically
// against the backend's stored start_date / end_date.
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
  international: { chip: "bg-violet-100 text-violet-700 border-violet-200" },
  national:      { chip: "bg-amber-100 text-amber-800 border-amber-200" },
  state:         { chip: "bg-sky-100 text-sky-700 border-sky-200" },
  club:          { chip: "bg-slate-100 text-slate-700 border-slate-200" },
};

const BREAK_SCOPE_LABEL = {
  all: "Everyone",
  athletes: "All athletes",
  coaches: "All coaches",
  staff: "All staff",
  institution: "Institution",
  selected: "Selected",
};

export default function AdminConsole() {
  const [summary, setSummary] = useState(null);
  const [otNeedsReview, setOtNeedsReview] = useState(null);
  const [camps, setCamps] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [regattas, setRegattas] = useState([]);

  useEffect(() => {
    api.get("/admin/summary").then(setSummary).catch(() => {});
    api.get("/admin/overtime/needs-review").then(setOtNeedsReview).catch(() => {});
    api.get("/camps").then((r) => setCamps(r || [])).catch(() => {});
    api.get("/breaks").then((r) => setBreaks(r || [])).catch(() => {});
    api.get("/regattas").then((r) => setRegattas(r || [])).catch(() => {});
  }, []);

  // "Coming up this week" — anything that's active during today..today+7 OR
  // starts within the next 7 days. Sort by start_date so the closest-up-next
  // shows leftmost.
  const upcoming = useMemo(() => {
    const today = ymd(new Date());
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 7);
    const horizonStr = ymd(horizon);
    const inWindow = (start, end) =>
      // Currently active (started, not yet ended)
      (start <= today && end >= today) ||
      // Starts in the next 7 days
      (start > today && start <= horizonStr);
    const items = [];
    for (const c of camps) {
      if (inWindow(c.start_date, c.end_date)) {
        items.push({ kind: "camp", id: c.id, name: c.name, start: c.start_date, end: c.end_date, raw: c });
      }
    }
    for (const b of breaks) {
      if (inWindow(b.start_date, b.end_date)) {
        items.push({ kind: "break", id: b.id, name: b.name, start: b.start_date, end: b.end_date, raw: b });
      }
    }
    for (const r of regattas) {
      if (inWindow(r.start_date, r.end_date)) {
        items.push({ kind: "regatta", id: r.id, name: r.name, start: r.start_date, end: r.end_date, raw: r });
      }
    }
    items.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    return items;
  }, [camps, breaks, regattas]);

  // 5 summary tiles — each gets a vibrant colour to make scanning easier.
  // These remain INFO tiles (not nav duplicates) — they show live counts but
  // route to the canonical sidebar destination.
  const cards = [
    { label: "Total members", value: summary?.total_members ?? "—", Icon: Users, color: "#0EA5E9", to: "/admin/members" },
    { label: "On campus now", value: summary?.on_campus ?? "—", Icon: ShieldCheck, color: "#10B981", to: "/presence" },
    { label: "Pending leaves", value: summary?.pending_leaves ?? "—", Icon: CalendarCheck2, color: "#F59E0B", to: "/admin/approvals?tab=leaves" },
    { label: "On leave / tour", value: summary?.on_leave_tour ?? "—", Icon: Plane, color: "#F97316", to: "/admin/approvals?tab=leaves" },
    { label: "Late today", value: summary?.late_today ?? "—", Icon: Clock, color: "#EF4444", to: "/admin/reports" },
  ];

  // Quick actions only show items NOT already reachable from the sidebar —
  // single point of access keeps the admin's mental model clean. Items now in
  // the sidebar (Manage Members, Leave/Tour, Leave balances, Monthly Payroll,
  // Institutions, Calendar, Backup & Restore) are deliberately excluded.
  const links = [
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Admin Console</h1>
        <p className="text-slate-500 text-sm mt-1">Everything you need to run the campus.</p>
      </header>

      {otNeedsReview && (otNeedsReview.total_pending > 0 || otNeedsReview.comp_off_pending > 0) && (
        <div className="space-y-3 mb-6">
          {otNeedsReview.total_pending > 0 && (
            <Link
              to={`/admin/approvals?tab=overtime&status=pending${otNeedsReview.yesterday ? `&from=${otNeedsReview.yesterday}&to=${otNeedsReview.yesterday}` : ""}`}
              className="block iu-card p-4 border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 transition"
              data-testid="overtime-banner"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-extrabold text-amber-900">
                    {otNeedsReview.yesterday_count > 0
                      ? `${otNeedsReview.yesterday_count} overtime ${otNeedsReview.yesterday_count === 1 ? "entry" : "entries"} from yesterday need your review`
                      : `${otNeedsReview.total_pending} pending overtime ${otNeedsReview.total_pending === 1 ? "entry" : "entries"} to review`}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">Tap to approve or reject with a note.</div>
                </div>
                <ChevronRight size={20} className="text-amber-700 shrink-0" />
              </div>
            </Link>
          )}
          {otNeedsReview.comp_off_pending > 0 && (
            <Link
              to="/admin/approvals?tab=leaves&type=comp_off"
              className="block iu-card p-4 border-2 border-violet-300 bg-violet-50 hover:bg-violet-100 transition"
              data-testid="comp-off-banner"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-violet-200 text-violet-800 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-extrabold text-violet-900">
                    {otNeedsReview.comp_off_pending} compensatory off {otNeedsReview.comp_off_pending === 1 ? "request" : "requests"} awaiting approval
                  </div>
                  <div className="text-xs text-violet-800 mt-0.5">Members claimed comp-offs for working on their weekly off — review them.</div>
                </div>
                <ChevronRight size={20} className="text-violet-700 shrink-0" />
              </div>
            </Link>
          )}
        </div>
      )}

      {upcoming.length > 0 && (
        <Link
          to="/admin/calendar"
          data-testid="upcoming-banner"
          className="block iu-card p-4 mb-6 border-2 border-sky-200 bg-sky-50/40 hover:bg-sky-50 transition"
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="w-9 h-9 rounded-lg bg-sky-600 text-white flex items-center justify-center shrink-0 shadow-sm">
              <CalendarDays size={16} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-extrabold text-slate-900 text-sm leading-tight">Coming up this week</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                {upcoming.length} event{upcoming.length === 1 ? "" : "s"} active or starting in the next 7 days · tap to open the calendar
              </div>
            </div>
            <ChevronRight size={18} className="text-sky-700 shrink-0" />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" data-testid="upcoming-strip">
            {upcoming.map((e) => (
              <UpcomingChip key={`${e.kind}-${e.id}`} entry={e} />
            ))}
          </div>
        </Link>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8" data-testid="admin-summary-cards">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="iu-card p-4 hover:shadow-lg transition border-2"
            style={{
              background: `linear-gradient(135deg, ${c.color}18 0%, ${c.color}05 100%)`,
              borderColor: c.color + "33",
            }}
            data-testid={`summary-${c.label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 shadow-sm" style={{ background: c.color, color: "#fff" }}>
              <c.Icon size={20} />
            </div>
            <div className="text-2xl font-extrabold" style={{ color: c.color }}>{c.value}</div>
            <div className="text-xs font-bold uppercase tracking-wide mt-0.5 text-slate-700">{c.label}</div>
          </Link>
        ))}
      </div>

      <h2 className="font-extrabold tracking-tight mb-3">Coming up</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
        {links.length === 0 ? (
          <p className="text-sm text-slate-500 col-span-2">Everything is reachable from the sidebar — pick a section on the left.</p>
        ) : links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            data-testid={`link-${l.to.replace(/\W+/g, "-")}`}
            className="iu-card p-4 hover:shadow-lg transition flex items-center gap-3 border-2"
            style={{
              backgroundColor: l.color + "10",   // ~6% opacity tint
              borderColor: l.color + "33",       // ~20% opacity border
            }}
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
              style={{ backgroundColor: l.color, color: "#fff" }}
            >
              <l.Icon size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-900">{l.label}</div>
              <div className="text-xs text-slate-600 mt-0.5">{l.desc}</div>
            </div>
            <ArrowRight size={16} style={{ color: l.color }} />
          </Link>
        ))}
      </div>
    </div>
  );
}


// Compact horizontal chip for the "Coming up this week" strip. Visual tone
// keys off `kind`; secondary line shows the date range (or scope for breaks).
function UpcomingChip({ entry }) {
  const { kind, name, start, end, raw } = entry;
  const today = ymd(new Date());
  const isLive = start <= today && end >= today;
  const rangeLabel = start === end
    ? shortDate(start)
    : `${shortDate(start)} → ${shortDate(end)}`;

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
    const tone = REGATTA_LEVEL_TONE[raw.level]?.chip || REGATTA_LEVEL_TONE.club.chip;
    toneClasses = `bg-white border ${tone}`;
    kindLabel = (raw.level || "Regatta").replace(/^\w/, (c) => c.toUpperCase());
    extra = raw.location || null;
  }

  return (
    <div
      className={`shrink-0 min-w-[180px] max-w-[220px] rounded-lg border px-3 py-2 ${toneClasses}`}
      data-testid={`upcoming-${kind}-${entry.id}`}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={12} />
        <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{kindLabel}</span>
        {isLive && (
          <span className="ml-auto text-[9px] font-extrabold px-1.5 rounded bg-red-600 text-white">LIVE</span>
        )}
      </div>
      <div className="text-sm font-bold truncate mt-1" title={name}>{name}</div>
      <div className="text-[10px] opacity-75 truncate">{rangeLabel}</div>
      {extra && <div className="text-[10px] opacity-60 truncate">{extra}</div>}
    </div>
  );
}
