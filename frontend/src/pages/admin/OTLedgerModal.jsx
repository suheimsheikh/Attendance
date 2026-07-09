/**
 * OTLedgerModal — date-wise overtime ledger for a single member across
 * the currently-selected report year. Opens on double-click of any
 * Comp-off cell (Earned / Applied / Approved) on the Attendance report.
 *
 * Read-only. Server does all the aggregation via /api/reports/ot-ledger.
 */
import React, { useEffect, useState } from "react";
import { X, Loader2, Download } from "lucide-react";
import { api, showApiError, downloadBlob } from "../../api";

const STATUS_TINT = {
  pending:  "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
};

function fmtMin(m) {
  if (!m) return "—";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
}
function timeOnly(iso) {
  if (!iso) return "—";
  return iso.slice(11, 16);
}
// dd/mm/yyyy — matches the format used across the rest of the reports
// (see reports.py `_ddmmyyyy`). Falls back to the raw string if the
// date isn't in ISO shape.
function fmtDDMMYYYY(iso) {
  if (!iso) return "—";
  const parts = String(iso).split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

export default function OTLedgerModal({ open, onClose, memberId, memberName, year }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !memberId) return;
    setLoading(true);
    api.get(`/reports/ot-ledger?member_id=${memberId}&year=${year}`)
      .then((r) => { setRows(r?.rows || []); setMeta(r || {}); })
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [open, memberId, year]);

  if (!open) return null;

  return (
    <div
      className="iu-modal"
      data-testid="ot-ledger-modal"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="iu-modal-card max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <header className="p-4 border-b border-slate-100 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold truncate">Overtime ledger — {memberName || meta.member_name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {year} · {rows.length} session{rows.length === 1 ? "" : "s"} · <b>{fmtMin(meta.total_minutes)}</b> total
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {rows.length > 0 && (
              <button
                onClick={() => downloadBlob(
                  "/reports/ot-ledger/export",
                  `ot_ledger_${(memberName || "member").replace(/\s+/g, "_")}_${year}.pdf`,
                  { member_id: memberId, year, fmt: "pdf" },
                )}
                className="iu-btn-secondary text-xs"
                data-testid="ot-ledger-download-pdf"
                title="Download this ledger as a PDF"
              >
                <Download size={14} /> PDF
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1" data-testid="ot-ledger-close">
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="max-h-[70vh] overflow-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-slate-500 text-sm italic">No overtime recorded for {year}.</p>
          ) : (
            <table className="w-full text-xs iu-table-compact">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr className="text-left text-slate-600 font-semibold">
                  <th className="py-1.5 pr-3">Date</th>
                  <th className="py-1.5 pr-3">Check-in</th>
                  <th className="py-1.5 pr-3">Check-out</th>
                  <th className="py-1.5 pr-3 text-right" title="Minutes credited for arriving before your work-start time on this date.">Early Arrival</th>
                  <th className="py-1.5 pr-3 text-right" title="Minutes credited for staying past your work-end time on this date.">Late Departures</th>
                  <th className="py-1.5 pr-3 text-right">Total</th>
                  <th className="py-1.5 pr-3">Early reason</th>
                  <th className="py-1.5 pr-3">Late reason</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  // Post-8-Jul-2026 rows carry the split reasons; older
                  // rows only have the merged `overtime_reason`. Fall
                  // back gracefully: attribute the legacy reason to
                  // whichever half actually recorded minutes.
                  const earlyReason = r.overtime_early_reason
                    || (r.overtime_early_min && !r.overtime_late_min ? r.overtime_reason : "");
                  const lateReason = r.overtime_late_reason
                    || (r.overtime_late_min && !r.overtime_early_min ? r.overtime_reason : "");
                  return (
                    <tr key={r.date + (r.check_in_at || "")} className="border-t border-slate-100 hover:bg-slate-50/60"
                        data-testid={`ot-ledger-row-${r.date}`}>
                      <td className="py-1.5 pr-3 font-mono">{fmtDDMMYYYY(r.date)}</td>
                      <td className="py-1.5 pr-3 font-mono text-slate-600">{timeOnly(r.check_in_at)}</td>
                      <td className="py-1.5 pr-3 font-mono text-slate-600">{timeOnly(r.check_out_at)}</td>
                      <td className="py-1.5 pr-3 text-right text-emerald-700">{fmtMin(r.overtime_early_min)}</td>
                      <td className="py-1.5 pr-3 text-right text-amber-700">{fmtMin(r.overtime_late_min)}</td>
                      <td className="py-1.5 pr-3 text-right font-bold">{fmtMin(r.overtime_total_min)}</td>
                      <td className="py-1.5 pr-3 text-slate-600 italic max-w-[160px] truncate" title={earlyReason || ""}
                          data-testid={`ot-ledger-early-reason-${r.date}`}>
                        {earlyReason || <span className="not-italic text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-600 italic max-w-[160px] truncate" title={lateReason || ""}
                          data-testid={`ot-ledger-late-reason-${r.date}`}>
                        {lateReason || <span className="not-italic text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5">
                        <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border ${STATUS_TINT[r.overtime_status] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                          {r.overtime_status || "—"}
                        </span>
                        {r.overtime_admin_note && (
                          <div className="text-[10px] text-slate-500 italic mt-0.5" title={r.overtime_admin_note}>{r.overtime_admin_note}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals row (04 Feb 2026 user-requested). Sums minutes
                  across every row shown; empty cells for date/session
                  cols so the row reads clean. */}
              <tfoot className="sticky bottom-0 bg-slate-100 border-t-2 border-slate-300">
                <tr className="font-bold text-slate-800" data-testid="ot-ledger-totals">
                  <td className="py-2 pr-3" colSpan={3}>Totals</td>
                  <td className="py-2 pr-3 text-right text-emerald-800">
                    {fmtMin(rows.reduce((s, r) => s + (r.overtime_early_min || 0), 0))}
                  </td>
                  <td className="py-2 pr-3 text-right text-amber-800">
                    {fmtMin(rows.reduce((s, r) => s + (r.overtime_late_min || 0), 0))}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {fmtMin(rows.reduce((s, r) => s + (r.overtime_total_min || 0), 0))}
                  </td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
