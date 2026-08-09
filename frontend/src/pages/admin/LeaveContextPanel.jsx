/**
 * LeaveContextPanel — inline decision-support for pending leave rows on
 * the Approvals table. Given a leave (row.raw carries user_id, dates,
 * id, type) the panel fetches:
 *
 *   • other leaves/tours overlapping the same window (via
 *     /leaves/overlap, excluding the applicant's own row)
 *   • regattas + camps overlapping the window (via
 *     /leaves/event-conflicts, scoped to the applicant so member-roster
 *     camps only surface when actually relevant)
 *
 * Both endpoints existed already — the Approvals UI just wasn't
 * surfacing them. Rendered as a collapsible sub-row below the leave
 * so the compact table stays scannable; expanding a leave gives the
 * admin the full picture in one place.
 *
 * Colour cues:
 *   • rose  — applicant is expected at an international regatta or
 *             a member-scoped camp during the leave (strong warning)
 *   • amber — 3+ other members already on leave/tour those days
 *             (staffing risk, but decidable)
 *   • else  — neutral: nothing pressing, all clear
 */
import React from "react";
import { Loader2, Users, Trophy, Tent } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api";
import { formatDate } from "../../utils";

const TYPE_TINT = {
  leave:      "bg-amber-100 text-amber-800",
  tour:       "bg-sky-100 text-sky-800",
  posting:    "bg-violet-100 text-violet-800",
  comp_off:   "bg-slate-100 text-slate-700",
};

const LEVEL_TINT = {
  international: "bg-rose-100 text-rose-800",
  national:      "bg-amber-100 text-amber-800",
  state:         "bg-emerald-100 text-emerald-800",
  club:          "bg-slate-100 text-slate-700",
};

function dateRange(start, end) {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  return `${formatDate(start)} → ${formatDate(end)}`;
}

export default function LeaveContextPanel({ leave }) {
  // `leave` is the raw pending row (user_id, id, start_date, end_date).
  // Keys are stable so React Query dedupes overlapping expansions and
  // caches the response for the full Approvals session.
  const overlapQ = useQuery({
    queryKey: ["/leaves/overlap", { start_date: leave.start_date, end_date: leave.end_date, exclude_user_id: leave.user_id, leave_id: leave.id }],
    queryFn: () => api.get("/leaves/overlap", { start_date: leave.start_date, end_date: leave.end_date, exclude_user_id: leave.user_id, leave_id: leave.id }),
    staleTime: 60_000,
  });
  const eventsQ = useQuery({
    queryKey: ["/leaves/event-conflicts", { start_date: leave.start_date, end_date: leave.end_date, user_id: leave.user_id }],
    queryFn: () => api.get("/leaves/event-conflicts", { start_date: leave.start_date, end_date: leave.end_date, user_id: leave.user_id }),
    staleTime: 60_000,
  });

  const loading = overlapQ.isLoading || eventsQ.isLoading;
  const others = overlapQ.data || [];
  const regattas = eventsQ.data?.regattas || [];
  const camps = eventsQ.data?.camps || [];

  // Highest-severity signal for the header colour.
  const hasIntlRegatta = regattas.some((r) => (r.level || "").toLowerCase() === "international");
  const hasCamp = camps.length > 0;
  const heavyOverlap = others.length >= 3;
  const tone = (hasIntlRegatta || hasCamp)
    ? "border-rose-200 bg-rose-50/60"
    : heavyOverlap
      ? "border-amber-200 bg-amber-50/60"
      : "border-slate-200 bg-slate-50/60";

  if (loading) {
    return (
      <div className="p-3 border-t border-slate-200 bg-slate-50/60 text-xs text-slate-500 flex items-center gap-2"
           data-testid="leave-context-loading">
        <Loader2 size={12} className="animate-spin" />
        Loading context…
      </div>
    );
  }

  const nothing = others.length === 0 && regattas.length === 0 && camps.length === 0;
  if (nothing) {
    return (
      <div className="p-3 border-t border-slate-200 bg-emerald-50/60 text-xs text-emerald-800 font-medium"
           data-testid="leave-context-empty">
        ✓ Clear window — no other absences, regattas or camps in this range.
      </div>
    );
  }

  return (
    <div className={`p-3 border-t ${tone} space-y-2.5`} data-testid="leave-context-panel">
      {(hasIntlRegatta || hasCamp) && (
        <div className="text-xs font-semibold text-rose-800" data-testid="leave-context-warning">
          ⚠ This member may be expected at a scheduled event during the requested leave.
        </div>
      )}

      {others.length > 0 && (
        <section data-testid="leave-context-others">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
            <Users size={12} /> Other absences ({others.length})
          </div>
          <ul className="space-y-1">
            {others.slice(0, 12).map((o) => (
              <li key={o.id}
                  className="flex flex-wrap items-center gap-2 text-xs"
                  data-testid={`leave-context-other-${o.id}`}>
                <span className="font-semibold text-slate-900 truncate max-w-[220px]">{o.full_name}</span>
                {o.institution && (
                  <span className="inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold bg-sky-100 text-sky-700">
                    {o.institution}
                  </span>
                )}
                {o.category && o.category !== "athlete" && (
                  <span className="inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold bg-slate-100 text-slate-700 capitalize">
                    {o.category}
                  </span>
                )}
                <span className={`inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold uppercase ${TYPE_TINT[o.type] || "bg-slate-100 text-slate-700"}`}>
                  {o.type}
                </span>
                {o.status === "pending" && (
                  <span className="inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                    pending
                  </span>
                )}
                <span className="text-slate-500 tabular-nums">{dateRange(o.start_date, o.end_date)}</span>
              </li>
            ))}
            {others.length > 12 && (
              <li className="text-xs text-slate-500 italic pl-1">
                …and {others.length - 12} more
              </li>
            )}
          </ul>
        </section>
      )}

      {regattas.length > 0 && (
        <section data-testid="leave-context-regattas">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
            <Trophy size={12} /> Regattas in window ({regattas.length})
          </div>
          <ul className="space-y-1">
            {regattas.map((r) => (
              <li key={r.id}
                  className="flex flex-wrap items-center gap-2 text-xs"
                  data-testid={`leave-context-regatta-${r.id}`}>
                <span className="font-semibold text-slate-900 truncate max-w-[280px]" title={r.name}>{r.name}</span>
                {r.level && (
                  <span className={`inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold uppercase ${LEVEL_TINT[r.level.toLowerCase()] || "bg-slate-100 text-slate-700"}`}>
                    {r.level}
                  </span>
                )}
                {r.location && (
                  <span className="text-slate-600 text-[11px]">
                    {r.location}{r.country && r.country !== "India" ? `, ${r.country}` : ""}
                  </span>
                )}
                <span className="text-slate-500 tabular-nums">{dateRange(r.start_date, r.end_date)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {camps.length > 0 && (
        <section data-testid="leave-context-camps">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-700 uppercase tracking-wider mb-1">
            <Tent size={12} /> Camps in window ({camps.length})
          </div>
          <ul className="space-y-1">
            {camps.map((c) => (
              <li key={c.id}
                  className="flex flex-wrap items-center gap-2 text-xs"
                  data-testid={`leave-context-camp-${c.id}`}>
                <span className="font-semibold text-slate-900 truncate max-w-[260px]" title={c.name}>{c.name}</span>
                {c.institution && (
                  <span className="inline-flex items-center px-1.5 h-4 rounded text-[10px] font-bold bg-sky-100 text-sky-700">
                    {c.institution}
                  </span>
                )}
                {Array.isArray(c.days_of_week) && c.days_of_week.length > 0 && c.days_of_week.length < 7 && (
                  <span className="text-slate-500 text-[11px] uppercase">
                    {c.days_of_week.join("·")}
                  </span>
                )}
                <span className="text-slate-500 tabular-nums">{dateRange(c.start_date, c.end_date)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
