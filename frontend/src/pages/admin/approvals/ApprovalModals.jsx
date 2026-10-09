import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { round1 } from "../../leaves/utils";

// ---------------------------------------------------------------------------
// BalanceChip — inline "X days available" pill under the member name on
// pending LEAVE rows. Colour flips to rose when the requested days would
// exceed the paid-leave + comp-off pool, so admins can spot LOP-triggering
// approvals at a glance without expanding the context panel.
// ---------------------------------------------------------------------------
export function BalanceChip({ data, requestedDays, testid }) {
  if (!data) {
    return (
      <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-slate-400" data-testid={testid}>
        <Loader2 size={9} className="animate-spin" /> balance…
      </div>
    );
  }
  if (data.error) return null;
  const co = data.comp_off?.available || 0;
  const pl = data.paid_leave?.available || 0;
  const total = round1(co + pl);
  const shortfall = requestedDays > total;
  return (
    <div
      className={`mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
        shortfall ? "bg-rose-100 text-rose-700" : "bg-emerald-50 text-emerald-700"
      }`}
      data-testid={testid}
      title={shortfall
        ? `Only ${total} day(s) available for ${requestedDays} requested — approving will trigger LOP`
        : `${total} day(s) available (${co} comp-off + ${round1(pl)} paid leave)`}
    >
      {shortfall ? <AlertTriangle size={9} /> : <Check size={9} />}
      {total} avail
    </div>
  );
}

// ---------------------------------------------------------------------------
// RejectReasonModal — mandatory denial reason on a leave rejection. Sent
// as `denial_reason` on the PATCH so the applicant sees "why" when they
// check their own leave list. Kept inline (no separate file) because the
// modal lifecycle is tightly coupled to the parent's decide() flow.
// ---------------------------------------------------------------------------
// Common denial reasons — a small dropdown pre-fills the textarea so
// admins can reject in one click while still capturing an audit trail.
// Admin can still type a fresh reason on top of, or in place of, the
// suggestion. Per-kind lists so a check-in reject doesn't show
// leave-specific suggestions.
const REJECT_SUGGESTIONS = {
  leave: [
    "Camp overlap — please re-plan",
    "Regatta duty during this window",
    "Insufficient balance — apply comp-off first",
    "Advance notice too short",
    "Peak workload — no cover available",
  ],
  checkin: [
    "Off-geofence without valid reason",
    "Wrong location",
    "Late arrival — no supporting evidence",
    "Selfie / method inconsistent with muster",
  ],
  correction: [
    "Wrong entity — please re-file against the correct row",
    "Incorrect date",
    "Duplicate request — already actioned",
    "Insufficient supporting details",
  ],
};

export function RejectReasonModal({ row, reason, onReasonChange, busy, onCancel, onSubmit }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" data-testid="reject-modal">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-extrabold text-slate-900">Reject request</h3>
          <p className="text-xs text-slate-500 mt-1">
            {row.member_name} · {row.when}
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider" htmlFor="reject-reason">
            Reason for rejection *
          </label>
          {(REJECT_SUGGESTIONS[row.kind] || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="reject-suggestions">
              {REJECT_SUGGESTIONS[row.kind].map((s) => {
                const active = reason.trim() === s;
                return (
                  <button
                    key={s}
                    type="button"
                    data-testid={`reject-suggestion-${s.slice(0, 20).replace(/[^a-z0-9]/gi, "-").toLowerCase()}`}
                    onClick={() => onReasonChange(s)}
                    className={`text-[11px] px-2 py-1 rounded-full border transition ${
                      active
                        ? "bg-rose-600 text-white border-rose-600"
                        : "bg-white text-slate-700 border-slate-300 hover:bg-rose-50 hover:border-rose-300"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
              <button title="Clear the selection"
                type="button"
                data-testid="reject-suggestion-clear"
                onClick={() => onReasonChange("")}
                className="text-[11px] px-2 py-1 rounded-full border border-transparent text-slate-500 hover:text-slate-800 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
          <textarea
            id="reject-reason"
            data-testid="reject-reason-input"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
            placeholder="Tap a common reason above, or write a fresh one here"
          />
          <p className="text-[11px] text-slate-500">
            The applicant will see this on their own list — please be specific.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button title="Close without saving"
            type="button"
            data-testid="reject-modal-cancel"
            onClick={onCancel}
            disabled={busy}
            className="iu-btn-secondary !h-9 !px-3 !text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="reject-modal-confirm"
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="iu-btn-primary !h-9 !px-3 !text-sm !bg-rose-600 hover:!bg-rose-700"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            Reject request
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverrideReasonModal — mandatory LOP override reason on Approve when the
// applicant's balance falls short of the requested days. Copies the visual
// pattern of RejectReasonModal but frames the action positively (Approve
// with LOP) and hard-shows the shortfall so admins can't miss it.
// ---------------------------------------------------------------------------
export function OverrideReasonModal({ row, reason, onReasonChange, busy, onCancel, onSubmit }) {
  const requested = row._requested;
  const available = row._available;
  const shortfall = round1(Math.max(0, requested - available));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" data-testid="override-modal">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-100 bg-amber-50/70">
          <h3 className="text-lg font-extrabold text-amber-900 inline-flex items-center gap-2">
            <AlertTriangle size={18} /> Balance shortfall — approve with LOP?
          </h3>
          <p className="text-xs text-amber-800 mt-1">
            {row.member_name} · {row.when}
          </p>
          <p className="text-[11px] text-amber-800 mt-2">
            Requesting <strong>{requested}</strong> day(s) but only <strong>{available}</strong> available.
            Approving will LOP <strong className="uppercase">{shortfall} day{shortfall === 1 ? "" : "s"}</strong>.
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider" htmlFor="override-reason">
            Justification for the override *
          </label>
          <textarea
            id="override-reason"
            data-testid="override-reason-input"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            placeholder="e.g. Bereavement — approving as LOP with the member's consent"
          />
          <p className="text-[11px] text-slate-500">
            Recorded on the leave audit trail as `approval_override_reason` for future reference.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button title="Close without saving" type="button" data-testid="override-modal-cancel" onClick={onCancel} disabled={busy} className="iu-btn-secondary !h-9 !px-3 !text-sm">Cancel</button>
          <button
            type="button"
            data-testid="override-modal-confirm"
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="iu-btn-primary !h-9 !px-3 !text-sm !bg-amber-600 hover:!bg-amber-700"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Approve with LOP
          </button>
        </div>
      </div>
    </div>
  );
}
