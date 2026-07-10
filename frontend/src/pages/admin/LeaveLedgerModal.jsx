/**
 * LeaveLedgerModal — chronological leave ledger for a single member
 * across the currently-selected report year. Opens on double-click of
 * any of the five Leave cells (Open · COff · Total · Avld · Close) on
 * the Attendance report.
 *
 * Read-only. Server aggregates via /api/reports/leave-ledger. Rows
 * carry `applied` (pending), `availed` (approved) and `rejected`
 * classifications with totals in the header.
 */
import React, { useEffect, useState } from "react";
import { X, Loader2, Download } from "lucide-react";
import { api, showApiError, downloadBlob } from "../../api";

const KIND_TINT = {
  applied:  "bg-amber-100 text-amber-800 border-amber-200",
  availed:  "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
};

export default function LeaveLedgerModal({ open, onClose, memberId, memberName, year, month }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !memberId) return;
    setLoading(true);
    // Month-scoped by default (15 Feb 2026 user request).
    const qs = month ? `month=${month}` : `year=${year}`;
    api.get(`/reports/leave-ledger?member_id=${memberId}&${qs}`)
      .then((r) => { setRows(r?.rows || []); setMeta(r || {}); })
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [open, memberId, year, month]);

  if (!open) return null;

  const totals = meta.totals || {};
  const windowLabel = meta.window_label || month || String(year || "");
  return (
    <div
      className="iu-modal"
      data-testid="leave-ledger-modal"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="iu-modal-card max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <header className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Leave ledger — {memberName || meta.member_name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {windowLabel} &nbsp;·&nbsp;
              Applied <b className="text-amber-700">{totals.applied || 0}</b>
              &nbsp;·&nbsp; Availed <b className="text-emerald-700">{totals.availed || 0}</b>
              &nbsp;·&nbsp; Rejected <b className="text-rose-700">{totals.rejected || 0}</b>
              &nbsp;·&nbsp; Opening <b>{totals.opening ?? 0}</b>
              &nbsp;·&nbsp; Taken YTD <b>{totals.taken_ytd ?? 0}</b>
              &nbsp;·&nbsp; Remaining <b className={(totals.remaining ?? 0) < 0 ? "text-red-600" : "text-emerald-700"}>{totals.remaining ?? 0}</b>
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {rows.length > 0 && (
              <button
                onClick={() => downloadBlob(
                  "/reports/leave-ledger/export",
                  `leave_ledger_${(memberName || "member").replace(/\s+/g, "_")}_${windowLabel}.pdf`,
                  month
                    ? { member_id: memberId, month, fmt: "pdf" }
                    : { member_id: memberId, year, fmt: "pdf" },
                )}
                className="iu-btn-secondary text-xs"
                data-testid="leave-ledger-download-pdf"
                title="Download this ledger as a PDF"
              >
                <Download size={14} /> PDF
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1" data-testid="leave-ledger-close">
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
            <p className="text-slate-500 text-sm italic">No leave activity recorded for {windowLabel}.</p>
          ) : (
            <table className="w-full text-xs iu-table-compact">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr className="text-left text-slate-600 font-semibold">
                  <th className="py-1.5">Start</th>
                  <th className="py-1.5">DOW</th>
                  <th className="py-1.5">End</th>
                  <th className="py-1.5 text-right">Days</th>
                  <th className="py-1.5">Kind</th>
                  <th className="py-1.5">Reason</th>
                  <th className="py-1.5">Admin note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.start_date}-${r.kind}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/60"
                      data-testid={`leave-ledger-row-${r.start_date}-${r.kind}`}>
                    <td className="py-1.5 font-mono">{r.start_date}</td>
                    <td className="py-1.5 font-semibold text-slate-700">{r.dow}</td>
                    <td className="py-1.5 font-mono text-slate-600">{r.end_date}</td>
                    <td className="py-1.5 text-right font-bold">{r.qty}</td>
                    <td className="py-1.5">
                      <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border capitalize ${KIND_TINT[r.kind] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                        {r.kind}
                      </span>
                    </td>
                    <td className="py-1.5 text-slate-600 italic max-w-[220px] truncate" title={r.reason || ""}>
                      {r.reason || <span className="not-italic text-slate-300">—</span>}
                    </td>
                    <td className="py-1.5 text-slate-500 italic max-w-[180px] truncate" title={r.admin_note || ""}>
                      {r.admin_note || <span className="not-italic text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
