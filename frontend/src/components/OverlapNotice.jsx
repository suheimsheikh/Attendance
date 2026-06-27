import React, { useEffect, useState } from "react";
import { Users, Plane, Bed, RefreshCw, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { api } from "../api";
import { shortDate } from "../utils";

/**
 * OverlapNotice — surfaces other members who are on Leave / Tour / (legacy)
 * Comp-Off during a date range, so an applicant and the approving admin can
 * spot conflicts BEFORE the request is submitted / approved.
 *
 * Auto-fetches `/api/leaves/overlap` whenever (start_date, end_date,
 * exclude_user_id) change. Renders an inline collapsible card with grouped
 * chips per type.
 *
 * Props:
 *  - startDate, endDate: ISO date strings; both required.
 *  - excludeUserId: drop this user_id from the overlap list (use for the
 *                   applicant's own user_id, or in the Approvals view
 *                   leave it blank so the admin still sees their own row).
 *  - excludeLeaveId: drop a specific leave row from the result (used in
 *                   Approvals so the row being decided isn't double-counted).
 *  - title: override the heading. Defaults to "Overlap during this period".
 *  - defaultOpen: when true, render expanded by default. When false, render
 *                 collapsed with a single-line summary header.
 *  - dense: smaller padding for use inside table rows.
 */
export default function OverlapNotice({
  startDate,
  endDate,
  excludeUserId = null,
  excludeLeaveId = null,
  title = "Overlap during this period",
  defaultOpen = false,
  dense = false,
}) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(defaultOpen);

  useEffect(() => {
    if (!startDate || !endDate) { setRows([]); return; }
    let cancelled = false;
    setBusy(true);
    setError(null);
    (async () => {
      try {
        const params = { start_date: startDate, end_date: endDate };
        if (excludeUserId) params.exclude_user_id = excludeUserId;
        if (excludeLeaveId) params.leave_id = excludeLeaveId;
        const data = await api.get("/leaves/overlap", params);
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) { setError(err?.message || "Could not load overlap"); setRows([]); }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [startDate, endDate, excludeUserId, excludeLeaveId]);

  if (rows === null && busy) {
    return (
      <div className={`rounded-lg border border-slate-200 bg-slate-50/60 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"} flex items-center gap-2 text-xs text-slate-500`} data-testid="overlap-loading">
        <Loader2 size={12} className="animate-spin" /> Checking who else is on leave/tour…
      </div>
    );
  }
  if (error) return null;
  if (!rows || rows.length === 0) {
    return (
      <div className={`rounded-lg border border-emerald-200 bg-emerald-50/50 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"} flex items-center gap-2 text-xs text-emerald-900`} data-testid="overlap-empty">
        <Users size={12} className="text-emerald-700"/> No one else is on leave or tour during this period.
      </div>
    );
  }

  // Group by type for the chip layout
  const groups = { leave: [], tour: [], comp_off: [] };
  rows.forEach((r) => { (groups[r.type] || (groups[r.type] = [])).push(r); });
  const summary = [
    groups.leave.length && `${groups.leave.length} on Leave`,
    groups.tour.length && `${groups.tour.length} on Tour`,
    groups.comp_off.length && `${groups.comp_off.length} on Comp-Off`,
  ].filter(Boolean).join(" · ");

  return (
    <div className={`rounded-lg border border-amber-200 bg-amber-50/70 ${dense ? "px-2 py-1.5" : "px-3 py-2.5"}`} data-testid="overlap-notice">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        data-testid="overlap-toggle"
        className="flex items-center gap-2 w-full text-left text-amber-900"
        aria-expanded={open}
      >
        <Users size={dense ? 12 : 14} className="text-amber-700 shrink-0" />
        <div className="flex-1 min-w-0 text-xs font-semibold">
          {title} · <span className="font-extrabold">{summary}</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="mt-2 space-y-2" data-testid="overlap-details">
          {["leave", "tour", "comp_off"].map((kind) => {
            const list = groups[kind];
            if (!list || !list.length) return null;
            const Icon = kind === "tour" ? Plane : kind === "comp_off" ? RefreshCw : Bed;
            const colorCls = kind === "tour"
              ? "bg-orange-100 text-orange-800 border-orange-200"
              : kind === "comp_off"
                ? "bg-violet-100 text-violet-800 border-violet-200"
                : "bg-amber-100 text-amber-800 border-amber-200";
            return (
              <div key={kind} data-testid={`overlap-group-${kind}`}>
                <div className="text-[10px] uppercase tracking-wider font-bold text-amber-900/70 mb-1 inline-flex items-center gap-1">
                  <Icon size={10}/> {kind === "comp_off" ? "Comp-Off" : kind === "tour" ? "Tour" : "Leave"} ({list.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {list.map((r) => (
                    <span
                      key={r.id}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${colorCls}`}
                      title={`${shortDate(r.start_date)} → ${shortDate(r.end_date)}${r.status === "pending" ? " · pending" : ""}`}
                      data-testid={`overlap-chip-${r.id}`}
                    >
                      <span className="truncate max-w-[160px]">{r.full_name}</span>
                      <span className="opacity-60 text-[10px]">
                        {shortDate(r.start_date)}{r.start_date !== r.end_date ? `→${shortDate(r.end_date)}` : ""}
                      </span>
                      {r.status === "pending" && (
                        <span className="ml-0.5 text-[9px] font-bold uppercase tracking-wide bg-white/60 px-1 rounded">P</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="text-[10px] text-amber-900/60 pt-1">
            <span className="inline-block bg-white/60 px-1 rounded font-bold mr-1">P</span> = pending approval
          </div>
        </div>
      )}
    </div>
  );
}
