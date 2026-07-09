/**
 * AttendanceLedgerModal — date-wise attendance ledger for one member
 * across the currently-selected reporting range.
 *
 * Opens on double-click of any Attendance column on the report table
 * (Pres/Lv/Tour/Off/Late/Half/Abs/Tot). Read-only; the server does
 * all the classification via /api/reports/attendance-ledger so this
 * component stays a thin view.
 *
 * Status column values:
 *   • Present / Late / Half day  — actual check-ins
 *   • Leave / Tour / Posting     — covered by an approved leave
 *   • Comp-off                   — comp-off leave used
 *   • Weekly off                 — member's configured weekly_off
 *   • Holiday                    — office holiday
 *   • Absent                     — none of the above
 */
import React, { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import { api, showApiError } from "../../api";

// Colour-code each classification so the daily table scans quickly.
const STATUS_TINT = {
  "Present":    "bg-emerald-50 text-emerald-800 border-emerald-200",
  "Late":       "bg-yellow-50  text-yellow-800  border-yellow-200",
  "Half day":   "bg-orange-50  text-orange-800  border-orange-200",
  "Leave":      "bg-amber-50   text-amber-800   border-amber-200",
  "Tour":       "bg-sky-50     text-sky-800     border-sky-200",
  "Posting":    "bg-indigo-50  text-indigo-800  border-indigo-200",
  "Comp-off":   "bg-violet-50  text-violet-800  border-violet-200",
  "Weekly off": "bg-slate-100  text-slate-700   border-slate-200",
  "Holiday":    "bg-fuchsia-50 text-fuchsia-800 border-fuchsia-200",
  "Absent":     "bg-rose-50    text-rose-800    border-rose-200",
};

// Order in which the summary counts are shown at the top of the modal.
const COUNT_ORDER = ["Present", "Late", "Half day", "Leave", "Tour", "Posting",
                     "Comp-off", "Weekly off", "Holiday", "Absent"];

function fmtDDMMYYYY(iso) {
  if (!iso) return "—";
  const parts = String(iso).split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

export default function AttendanceLedgerModal({
  open, onClose, memberId, memberName, start, end,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !memberId) return;
    setLoading(true);
    api.get(`/reports/attendance-ledger?member_id=${memberId}&start=${start}&end=${end}`)
      .then((r) => setData(r))
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [open, memberId, start, end]);

  if (!open) return null;
  const rows = data?.rows || [];
  const counts = data?.counts || {};

  return (
    <div
      className="iu-modal"
      data-testid="attendance-ledger-modal"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="iu-modal-card max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <header className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold truncate">
              Attendance ledger — {memberName || data?.member_name}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {fmtDDMMYYYY(start)} to {fmtDDMMYYYY(end)} · {rows.length} day{rows.length === 1 ? "" : "s"}
              {data?.weekly_off ? <> · weekly off: <b className="text-slate-700">{data.weekly_off}</b></> : null}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1" data-testid="attendance-ledger-close">
            <X size={18} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
              {/* Summary chips — one per non-zero status, in the fixed order above. */}
              <div className="flex flex-wrap gap-1.5 mb-3" data-testid="attendance-ledger-counts">
                {COUNT_ORDER.filter((k) => (counts[k] || 0) > 0).map((k) => (
                  <span key={k}
                    className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${STATUS_TINT[k] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                    {k}
                    <span className="tabular-nums font-bold">{counts[k]}</span>
                  </span>
                ))}
              </div>

              <table className="w-full text-xs iu-table-compact">
                <thead className="sticky top-0 bg-slate-50 z-10">
                  <tr className="text-left text-slate-600 font-semibold">
                    <th className="py-1.5 pr-3">Date</th>
                    <th className="py-1.5 pr-3">Day</th>
                    <th className="py-1.5 pr-3">Status</th>
                    <th className="py-1.5 pr-3">Check-in</th>
                    <th className="py-1.5 pr-3">Check-out</th>
                    <th className="py-1.5">Reason / Note</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/60"
                        data-testid={`attn-ledger-row-${r.date}`}>
                      <td className="py-1.5 pr-3 font-mono">{fmtDDMMYYYY(r.date)}</td>
                      <td className="py-1.5 pr-3 text-slate-600">{r.dow}</td>
                      <td className="py-1.5 pr-3">
                        <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border ${STATUS_TINT[r.status] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-slate-600">{r.check_in || "—"}</td>
                      <td className="py-1.5 pr-3 font-mono text-slate-600">{r.check_out || "—"}</td>
                      <td className="py-1.5 text-slate-600 italic max-w-[280px] truncate" title={r.reason || ""}>
                        {r.reason || <span className="not-italic text-slate-300">—</span>}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td colSpan={6} className="text-center py-6 text-slate-400 italic">No days in range.</td></tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
