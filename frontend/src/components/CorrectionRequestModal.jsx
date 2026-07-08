/**
 * CorrectionRequestModal — one shared modal that raises any of the 5
 * launch-day correction kinds. The parent passes the initial
 * entity_type/kind (so the CheckIn page opens straight to
 * "missed_checkin", MyLeaves opens to "leave_date_change", etc.) and
 * the modal handles the rest.
 *
 * Design:
 *  • kind-specific fields are gated by the `kind` state so we always
 *    render exactly what applies — a leave_cancel needs only a reason,
 *    a missed_checkin needs check-in / check-out times, etc.
 *  • target_date is capped to the last 7 days (server also enforces).
 *  • Submits to POST /api/corrections and toasts on success.
 */
import React, { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";

// Human-readable labels for the kind dropdown.
const KIND_LABELS = {
  missed_checkin:    "I forgot to punch in",
  time_adjust:       "My check-in time is wrong",
  leave_date_change: "The dates on my leave are wrong",
  leave_cancel:      "Cancel this leave — shouldn't have run",
  leave_type_change: "Change the leave type",
};

// Kinds grouped by entity_type — drives the dropdown when the caller
// hasn't hard-locked a specific kind (e.g. from a generic corrections
// button).
const KINDS_BY_ENTITY = {
  attendance: ["missed_checkin", "time_adjust"],
  leave:      ["leave_date_change", "leave_cancel", "leave_type_change"],
};

function last7DaysMax() {
  return new Date().toISOString().slice(0, 10);
}
function last7DaysMin() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

export default function CorrectionRequestModal({
  open,
  onClose,
  onSaved,
  // Optional pre-fill from the calling page.
  entityType,      // "attendance" | "leave"
  entityId,        // for time_adjust / leave_* — the row being corrected
  initialKind,     // pre-select a kind in the dropdown
  targetDate,      // pre-fill the date if the caller knows it
  entityLabel,     // free-form display label so the member sees which row they're correcting
}) {
  const [kind, setKind] = useState(initialKind || (KINDS_BY_ENTITY[entityType] || KINDS_BY_ENTITY.attendance)[0]);
  const [date, setDate] = useState(targetDate || last7DaysMax());
  const [checkInTime, setCheckInTime] = useState("");
  const [checkOutTime, setCheckOutTime] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [newType, setNewType] = useState("leave");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const effectiveEntityType = entityType || (KINDS_BY_ENTITY.attendance.includes(kind) ? "attendance" : "leave");
  // When the modal is opened generically (no entityType locked by the
  // caller — e.g. from the "Raise correction" button on My Corrections),
  // the dropdown lists every kind so the member can pick between an
  // attendance vs a leave correction in one place. When it's launched
  // from a specific row (Check-in / Leave), only that entity's kinds
  // show because entity_id is bound.
  const kindOptions = entityType
    ? (KINDS_BY_ENTITY[effectiveEntityType] || [])
    : [...KINDS_BY_ENTITY.attendance, ...KINDS_BY_ENTITY.leave];

  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { toast.error("Reason is required"); return; }
    // Assemble the kind-specific payload — only send what applies.
    const payload = {};
    if (kind === "missed_checkin" || kind === "time_adjust") {
      if (checkInTime) payload.check_in_time = checkInTime;
      if (checkOutTime) payload.check_out_time = checkOutTime;
    } else if (kind === "leave_date_change") {
      if (startDate) payload.start_date = startDate;
      if (endDate) payload.end_date = endDate;
    } else if (kind === "leave_type_change") {
      payload.type = newType;
    }
    setSaving(true);
    try {
      await api.post("/corrections", {
        entity_type: effectiveEntityType,
        kind,
        entity_id: entityId || null,
        target_date: date,
        payload,
        reason: reason.trim(),
      });
      toast.success("Correction request submitted");
      onSaved?.();
      onClose?.();
    } catch (err) {
      showApiError(err, "Could not submit correction");
    } finally { setSaving(false); }
  };

  return (
    <div
      className="iu-modal"
      data-testid="correction-modal"
      // Stop-propagate + backdrop-only cancel — same guard as ConflictAcknowledgeModal.
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose?.(); }}
    >
      <form className="iu-modal-card max-w-lg" onSubmit={submit} onClick={(e) => e.stopPropagation()}>
        <header className="p-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold">Request a correction</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </header>
        <div className="p-4 space-y-3">
          {entityLabel && (
            <p className="text-xs text-slate-600 -mt-1">
              Correcting: <span className="font-semibold text-slate-800">{entityLabel}</span>
            </p>
          )}
          <div>
            <label className="iu-label">What went wrong?</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="iu-input"
              data-testid="correction-kind"
            >
              {kindOptions.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </select>
            {/* Non-missed_checkin kinds need an existing row (attendance
                or leave) to correct — when launched generically we can't
                bind the row here, so nudge the member back to the source
                page. Backend also rejects at approval time if entity_id
                is missing, but a friendly hint saves a round-trip. */}
            {!entityType && !entityId && kind !== "missed_checkin" && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1.5" data-testid="correction-row-hint">
                Tip — this kind needs an existing row. Open{" "}
                <b>{kind.startsWith("leave_") ? "Leave/Tour/Late" : "My Check In/Out"}</b>
                {" "}and use the correction button on the specific entry for the fastest turnaround.
              </p>
            )}
          </div>
          <div>
            <label className="iu-label">Which date does this apply to?</label>
            <input
              type="date" value={date}
              min={last7DaysMin()} max={last7DaysMax()}
              onChange={(e) => setDate(e.target.value)}
              className="iu-input" required
              data-testid="correction-date"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              Corrections can only be requested for the last 7 days.
            </p>
          </div>
          {(kind === "missed_checkin" || kind === "time_adjust") && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="iu-label">Correct check-in time</label>
                <input type="time" value={checkInTime} onChange={(e) => setCheckInTime(e.target.value)}
                  className="iu-input" data-testid="correction-checkin-time" />
              </div>
              <div>
                <label className="iu-label">Check-out time (optional)</label>
                <input type="time" value={checkOutTime} onChange={(e) => setCheckOutTime(e.target.value)}
                  className="iu-input" data-testid="correction-checkout-time" />
              </div>
            </div>
          )}
          {kind === "leave_date_change" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="iu-label">Correct start date</label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                  className="iu-input" data-testid="correction-start-date" />
              </div>
              <div>
                <label className="iu-label">Correct end date</label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                  className="iu-input" data-testid="correction-end-date" />
              </div>
            </div>
          )}
          {kind === "leave_type_change" && (
            <div>
              <label className="iu-label">Should this leave be recorded as</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value)}
                className="iu-input" data-testid="correction-new-type">
                <option value="leave">Leave</option>
                <option value="comp_off">Comp-Off</option>
                <option value="tour">Tour</option>
              </select>
            </div>
          )}
          <div>
            <label className="iu-label">Reason <span className="text-rose-500">*</span></label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Tell the admin what actually happened…"
              className="iu-input"
              required
              data-testid="correction-reason"
            />
          </div>
        </div>
        <footer className="p-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="iu-btn-ghost" data-testid="correction-cancel">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="iu-btn-primary" data-testid="correction-submit">
            {saving && <Loader2 size={14} className="animate-spin mr-1" />}
            Submit request
          </button>
        </footer>
      </form>
    </div>
  );
}
