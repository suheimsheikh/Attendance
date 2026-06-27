import React, { useEffect, useState } from "react";
import { AlertTriangle, Tent, Sailboat, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { api } from "../api";
import { shortDate } from "../utils";

/**
 * EventConflictNotice — alerts when the requested leave window collides
 * with a Camp the applicant is rostered into, or a Regatta active during
 * the same period.
 *
 * Two separate signals are surfaced with different severity:
 *   • Camp roster conflict   → HARD warning. The applicant is on the
 *                              camp's institution (and, when set, the
 *                              explicit member_ids roster). They almost
 *                              certainly shouldn't be on leave.
 *   • Regatta overlap        → INFO chip. Regattas don't carry a roster
 *                              in the current schema, so the admin sees
 *                              "Regatta X is on these dates" and decides.
 *
 * Auto-fetches `/api/leaves/event-conflicts` whenever (start, end,
 * userId) change. Hidden entirely when both lists are empty.
 *
 * Props:
 *  - startDate, endDate: ISO date strings.
 *  - userId:   target member id. Defaults to current user server-side.
 *              Pass the applicant's id from the Approvals detail row.
 *  - defaultOpen: render expanded by default (default false).
 *  - dense: smaller padding for use inside table rows.
 */
export default function EventConflictNotice({
  startDate,
  endDate,
  userId = null,
  defaultOpen = false,
  dense = false,
}) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!startDate || !endDate) { setData(null); return; }
    let cancelled = false;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const params = { start_date: startDate, end_date: endDate };
        if (userId) params.user_id = userId;
        const res = await api.get("/leaves/event-conflicts", params);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) { setError(err?.message || "Could not load conflicts"); setData({ camps: [], regattas: [] }); }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [startDate, endDate, userId]);

  if (busy && !data) {
    return (
      <div className={`rounded-lg border border-slate-200 bg-slate-50/60 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"} flex items-center gap-2 text-xs text-slate-500`} data-testid="event-conflicts-loading">
        <Loader2 size={12} className="animate-spin" /> Checking camps & regattas…
      </div>
    );
  }
  if (error || !data) return null;

  const camps = data.camps || [];
  const regattas = data.regattas || [];
  // Hide entirely when nothing relevant — keeps the form quiet for
  // members whose date range doesn't collide with any event.
  if (camps.length === 0 && regattas.length === 0) return null;

  // Camp roster conflict → red, always rendered as a hard warning.
  // Regattas → amber info chip.
  const hasCamp = camps.length > 0;
  const palette = hasCamp
    ? { border: "border-red-300",   bg: "bg-red-50/70",   text: "text-red-800",   icon: "text-red-600",   summaryText: "text-red-900" }
    : { border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-900", icon: "text-amber-600", summaryText: "text-amber-900" };

  const summary = [
    hasCamp     && `${camps.length} camp${camps.length === 1 ? "" : "s"} they're rostered into`,
    regattas.length && `${regattas.length} regatta${regattas.length === 1 ? "" : "s"} during this window`,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`rounded-lg border ${palette.border} ${palette.bg} ${dense ? "px-2 py-1.5" : "px-3 py-2.5"}`} data-testid="event-conflicts-notice">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="event-conflicts-toggle"
        aria-expanded={open}
        className={`flex items-center gap-2 w-full text-left ${palette.summaryText}`}
      >
        {hasCamp
          ? <AlertTriangle size={dense ? 12 : 14} className={`${palette.icon} shrink-0`} />
          : <Sailboat size={dense ? 12 : 14} className={`${palette.icon} shrink-0`} />}
        <div className="flex-1 min-w-0 text-xs font-semibold">
          {hasCamp ? "Possible camp/regatta conflict · " : "Regatta overlap · "}
          <span className="font-extrabold">{summary}</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="mt-2 space-y-2" data-testid="event-conflicts-details">
          {camps.length > 0 && (
            <div data-testid="event-conflicts-camps">
              <div className="text-[10px] uppercase tracking-wider font-bold text-red-800/80 mb-1 inline-flex items-center gap-1">
                <Tent size={10}/> Camps you&apos;re on ({camps.length})
              </div>
              <div className="space-y-1">
                {camps.map((c) => (
                  <div key={c.id} className="rounded-md bg-white/70 border border-red-200 px-2 py-1.5 text-[11px]" data-testid={`camp-conflict-${c.id}`}>
                    <div className="flex items-center gap-2">
                      <Tent size={11} className="text-red-600 shrink-0"/>
                      <div className="font-bold truncate">{c.name}</div>
                      <span className="text-[10px] uppercase font-bold bg-red-100 text-red-700 px-1 rounded shrink-0">
                        {c.match === "roster" ? "On roster" : c.institution || "Inst."}
                      </span>
                    </div>
                    <div className="text-slate-600 text-[10px] mt-0.5 font-mono">
                      {shortDate(c.start_date)} → {shortDate(c.end_date)}
                      {(c.days_of_week || []).length > 0 && (
                        <span className="ml-2 uppercase text-slate-500">({(c.days_of_week || []).join(", ")})</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {regattas.length > 0 && (
            <div data-testid="event-conflicts-regattas">
              <div className="text-[10px] uppercase tracking-wider font-bold text-amber-900/70 mb-1 inline-flex items-center gap-1">
                <Sailboat size={10}/> Regattas during this period ({regattas.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {regattas.slice(0, 8).map((r) => (
                  <span
                    key={r.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 border border-amber-200"
                    title={`${shortDate(r.start_date)} → ${shortDate(r.end_date)}${r.location ? " · " + r.location : ""}`}
                    data-testid={`regatta-conflict-${r.id}`}
                  >
                    <Sailboat size={9}/>
                    <span className="truncate max-w-[200px]">{r.name}</span>
                    <span className="opacity-60 text-[10px] font-mono">
                      {shortDate(r.start_date)}{r.start_date !== r.end_date ? `→${shortDate(r.end_date)}` : ""}
                    </span>
                  </span>
                ))}
                {regattas.length > 8 && (
                  <span className="text-[11px] text-amber-900/70 self-center">+{regattas.length - 8} more</span>
                )}
              </div>
              {!hasCamp && (
                <div className="text-[10px] text-amber-900/60 pt-1">
                  Regattas are organisation-wide — confirm with the applicant whether they were sailing it.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
