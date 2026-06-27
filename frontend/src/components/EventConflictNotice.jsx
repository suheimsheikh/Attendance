import React, { useEffect, useState } from "react";
import { CalendarRange, Tent, Sailboat, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { api } from "../api";
import { shortDate } from "../utils";

/**
 * EventConflictNotice — informational chip showing Camps + Regattas
 * active during the requested leave window. Both are surfaced as soft
 * amber notices (no hard red warning) so admins (and applicants) have
 * the heads-up without the system gating their decision.
 *
 * Auto-fetches `/api/leaves/event-conflicts` whenever (start, end,
 * userId) change. Hidden entirely when nothing overlaps.
 *
 * Props:
 *  - startDate, endDate: ISO date strings.
 *  - userId:   admin-only override of the target member id; defaults to
 *              the current user server-side. Kept for API symmetry — the
 *              listing is no longer user-scoped (per Jun 27 product call),
 *              so this is informational/audit only.
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
        if (!cancelled) { setError(err?.message || "Could not load events"); setData({ camps: [], regattas: [] }); }
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
  if (camps.length === 0 && regattas.length === 0) return null;

  const summary = [
    camps.length && `${camps.length} camp${camps.length === 1 ? "" : "s"}`,
    regattas.length && `${regattas.length} regatta${regattas.length === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`rounded-lg border border-amber-200 bg-amber-50/60 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"}`} data-testid="event-conflicts-notice">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="event-conflicts-toggle"
        aria-expanded={open}
        className="flex items-center gap-2 w-full text-left text-amber-900"
      >
        <CalendarRange size={dense ? 12 : 14} className="text-amber-700 shrink-0" />
        <div className="flex-1 min-w-0 text-xs font-semibold">
          Camps & regattas during this period · <span className="font-extrabold">{summary}</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="mt-2 space-y-2" data-testid="event-conflicts-details">
          {camps.length > 0 && (
            <div data-testid="event-conflicts-camps">
              <div className="text-[10px] uppercase tracking-wider font-bold text-amber-900/70 mb-1 inline-flex items-center gap-1">
                <Tent size={10}/> Camps ({camps.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {camps.slice(0, 8).map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 border border-amber-200"
                    title={`${shortDate(c.start_date)} → ${shortDate(c.end_date)}${c.institution ? " · " + c.institution : ""}`}
                    data-testid={`camp-conflict-${c.id}`}
                  >
                    <Tent size={9}/>
                    <span className="truncate max-w-[200px]">{c.name}</span>
                    <span className="opacity-60 text-[10px] font-mono">
                      {shortDate(c.start_date)}{c.start_date !== c.end_date ? `→${shortDate(c.end_date)}` : ""}
                    </span>
                  </span>
                ))}
                {camps.length > 8 && (
                  <span className="text-[11px] text-amber-900/70 self-center">+{camps.length - 8} more</span>
                )}
              </div>
            </div>
          )}
          {regattas.length > 0 && (
            <div data-testid="event-conflicts-regattas">
              <div className="text-[10px] uppercase tracking-wider font-bold text-amber-900/70 mb-1 inline-flex items-center gap-1">
                <Sailboat size={10}/> Regattas ({regattas.length})
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
            </div>
          )}
          <div className="text-[10px] text-amber-900/60 pt-1">
            Informational — confirm with the applicant whether any of these affect their plans.
          </div>
        </div>
      )}
    </div>
  );
}
