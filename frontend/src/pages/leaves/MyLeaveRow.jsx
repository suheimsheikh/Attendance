/**
 * MyLeaveRow — historical/active row in the "My Leave & Tour" list.
 *
 * Always shows: type pill · date range · status pill · reason.
 * On approved rows: who decided + decided-at + (for type=leave) the
 * ladder split that landed (Comp-Off used / Paid used / LOP).
 * On pending rows: nothing extra — the row is awaiting decision.
 * On rejected rows: who rejected + when.
 *
 * Extracted from MyLeaves.jsx on 14 Feb 2026.
 */
import React from "react";
import { AlertTriangle, RefreshCw, Bed } from "lucide-react";
import { TYPE_LABELS, STATUS_COLORS, round1 } from "./utils";
import { shortDate } from "../../utils";

export default function MyLeaveRow({ l }) {
  const t = TYPE_LABELS[l.type] || TYPE_LABELS.leave;
  const s = STATUS_COLORS[l.status] || STATUS_COLORS.pending;
  const showLadder = l.status === "approved" && l.type === "leave"
    && (l.comp_off_used != null || l.paid_leave_used != null || l.lop_days != null);
  return (
    <div className={`iu-card p-4 ${l.late_application ? "ring-2 ring-red-200 bg-red-50/50" : ""}`} data-testid={`myleave-${l.id}`}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: t.color + "22", color: t.color }}>
          <t.Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="font-semibold">{t.label}{l.location ? ` · ${l.location}` : ""}</div>
            {l.half_day && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-extrabold uppercase tracking-wide"
                data-testid={`myleave-halfday-${l.id}`}
                title={`Half-day (${l.half_day === "FN" ? "forenoon" : "postnoon"})`}
              >
                Half · {l.half_day}
              </span>
            )}
            {l.late_application && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-extrabold uppercase tracking-wide">
                <AlertTriangle size={10} /> Late
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500" data-testid={`myleave-dates-${l.id}`}>
            {shortDate(l.start_date)} – {shortDate(l.end_date)}
            {l.expected_arrival ? ` · arrival ${l.expected_arrival}` : ""}
          </div>
          {l.reason && (
            <div className="text-xs text-slate-700 mt-1.5" data-testid={`myleave-reason-${l.id}`}>
              <span className="text-slate-400 text-[10px] uppercase tracking-wider font-bold mr-1">Reason</span>
              {l.reason}
            </div>
          )}
          {(l.status === "approved" || l.status === "rejected") && l.decided_by && (
            <div className="text-[11px] text-slate-500 mt-1.5" data-testid={`myleave-decided-${l.id}`}>
              {l.status === "approved" ? "Approved" : "Rejected"} by <span className="font-semibold text-slate-700">{l.decided_by}</span>
              {l.decided_at ? ` · ${shortDate(l.decided_at)}` : ""}
            </div>
          )}
          {showLadder && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`myleave-ladder-${l.id}`}>
              {l.comp_off_used ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 text-violet-800 border border-violet-200">
                  <RefreshCw size={9}/> {l.comp_off_used} Comp-Off
                </span>
              ) : null}
              {l.paid_leave_used ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                  <Bed size={9}/> {round1(l.paid_leave_used)} Paid Leave
                </span>
              ) : null}
              {l.lop_days ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide bg-red-100 text-red-800 border border-red-200">
                  <AlertTriangle size={9}/> {l.lop_days} LOP
                </span>
              ) : null}
            </div>
          )}
        </div>
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold capitalize" style={{ background: s.bg, color: s.color }} data-testid={`myleave-status-${l.id}`}>
          {l.status}
        </span>
      </div>
    </div>
  );
}
