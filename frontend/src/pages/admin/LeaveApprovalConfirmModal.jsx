/**
 * LeaveApprovalConfirmModal — two-step guard for leave approvals.
 *
 * User request (24 Feb 2026): "After the first approval it should
 * mention all the contextual panel and seek a second approval from
 * the same approver." Rejections stay one-click — the safety net is
 * only on the "yes" path where a stray click could grant an absence
 * during a scheduled event.
 *
 * Renders a small dialog with:
 *   • applicant name + type + date range + reason recap
 *   • the same LeaveContextPanel used inline on the Approvals table
 *     (overlapping leaves, regattas, camps) so the approver sees the
 *     full picture without having to close & reopen the row
 *   • Cancel  → dismiss without touching the request
 *   • Confirm approval → fires the decision closure
 */
import React from "react";
import { X, Check, Loader2 } from "lucide-react";
import { formatDate } from "../../utils";
import LeaveContextPanel from "./LeaveContextPanel";

function daysBetween(start, end) {
  try {
    if (!start || !end) return 1;
    const s = new Date(start), e = new Date(end);
    return Math.max(1, Math.round((e - s) / 86_400_000) + 1);
  } catch { return 1; }
}

export default function LeaveApprovalConfirmModal({
  row,          // normalised approvals row (must carry .context, .member_name, .details, .when)
  busy,         // boolean — disables the confirm button while the decision is in flight
  onCancel,
  onConfirm,
}) {
  const ctx = row?.context;
  if (!row || !ctx) return null;

  const days = daysBetween(ctx.start_date, ctx.end_date);
  const range = ctx.end_date && ctx.end_date !== ctx.start_date
    ? `${formatDate(ctx.start_date)} → ${formatDate(ctx.end_date)}`
    : formatDate(ctx.start_date);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onCancel}
      data-testid="approval-confirm-backdrop"
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        data-testid="approval-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-confirm-title"
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 id="approval-confirm-title" className="text-lg font-extrabold text-slate-900">
              Confirm approval
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Review the context below and confirm to approve this request.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            aria-label="Cancel"
            data-testid="approval-confirm-close"
          >
            <X size={18} />
          </button>
        </header>

        {/* Applicant / request recap */}
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-extrabold text-slate-900" data-testid="approval-confirm-member">
              {row.member_name}
            </span>
            <span className="text-xs text-slate-500 tabular-nums" data-testid="approval-confirm-range">
              {range} <span className="text-slate-400">·</span> {days}d
            </span>
          </div>
          {row.details && (
            <p className="text-xs text-slate-600 mt-1" data-testid="approval-confirm-details">
              {row.details}
            </p>
          )}
        </div>

        {/* Contextual panel — same component used inline; the modal
            wrapper just gives it more visual weight before the
            final commit. */}
        <div className="flex-1 overflow-y-auto">
          <LeaveContextPanel leave={ctx} />
        </div>

        <footer className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="iu-btn-ghost !h-9 !px-4 text-sm"
            data-testid="approval-confirm-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="iu-btn-primary !h-9 !px-4 text-sm bg-emerald-600 hover:bg-emerald-700"
            data-testid="approval-confirm-approve"
            autoFocus
          >
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Check size={14}/>}
            Confirm approval
          </button>
        </footer>
      </div>
    </div>
  );
}
