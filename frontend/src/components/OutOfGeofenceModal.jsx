/**
 * OutOfGeofenceModal — asked before we submit a check-in whose GPS fix
 * fell outside every configured geofence. The member (or admin) MUST
 * pick or type a reason so the attendance row records WHY they were
 * off-site (e.g., "Docked at Necklace Rd", "Regatta at NSU").
 *
 * Reasons feed into a personal quick-pick bank on the backend (same
 * mechanism already used for overtime reasons).
 */
import React, { useState } from "react";
import { AlertTriangle, MapPin, X } from "lucide-react";

const QUICK_REASONS = [
  "At an unlisted training venue",
  "GPS drift — I'm actually on-site",
  "Regatta / external venue",
  "Boat maintenance off-site",
  "Coach-led outing",
];

export default function OutOfGeofenceModal({
  open,
  onClose,
  onConfirm,
  distanceM,
  nearestName,
  submitting = false,
  title = "You're outside every training location",
}) {
  const [reason, setReason] = useState("");
  if (!open) return null;

  const canSubmit = reason.trim().length >= 3 && !submitting;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
      onClick={onClose}
      data-testid="out-of-geofence-modal"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3 p-4 border-b border-slate-100">
          <div className="p-2 rounded-lg bg-amber-100 shrink-0">
            <AlertTriangle size={20} className="text-amber-700" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            <p className="text-[12px] text-slate-600 mt-0.5 flex items-center gap-1.5">
              <MapPin size={12} className="text-slate-400" />
              {distanceM != null && nearestName
                ? <>You are <b>~{distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${distanceM} m`}</b> from <b>{nearestName}</b>.</>
                : <>Location fix received but no training location matched.</>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 -mt-1"
            aria-label="Close"
            data-testid="off-geo-close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
              Quick reasons
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setReason(r)}
                  className={`px-2.5 h-7 rounded-full text-[12px] font-semibold border transition ${
                    reason === r
                      ? "bg-slate-900 text-white border-transparent"
                      : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                  }`}
                  data-testid={`off-geo-quick-${r.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="off-geo-reason" className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 block">
              Reason (required)
            </label>
            <textarea
              id="off-geo-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why you're checking in from outside…"
              className="w-full rounded-lg border border-slate-300 p-2 text-sm outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
              data-testid="off-geo-reason-textarea"
              autoFocus
            />
          </div>
        </div>

        <div className="p-3 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 h-9 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-200"
            data-testid="off-geo-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => onConfirm(reason.trim())}
            className="px-3 h-9 rounded-lg text-sm font-semibold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="off-geo-confirm"
          >
            {submitting ? "Submitting…" : "Check in anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
