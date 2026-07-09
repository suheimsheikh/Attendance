/**
 * CompOffLedgerModal — date-wise comp-off ledger for a single member
 * across the currently-selected report year. Opens on double-click of
 * any Comp-Off cell (Earned / Applied / Approved) on the Attendance
 * report.
 *
 * Read-only. Server does all the aggregation via
 * /api/reports/comp-off-ledger.
 */
import React, { useEffect, useState } from "react";
import { X, Loader2, Download } from "lucide-react";
import { api, showApiError, downloadBlob } from "../../api";

const KIND_TINT = {
  earned:   "bg-sky-100 text-sky-800 border-sky-200",
  applied:  "bg-amber-100 text-amber-800 border-amber-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-rose-100 text-rose-800 border-rose-200",
};

export default function CompOffLedgerModal({ open, onClose, memberId, memberName, year }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !memberId) return;
    setLoading(true);
    api.get(`/reports/comp-off-ledger?member_id=${memberId}&year=${year}`)
      .then((r) => { setRows(r?.rows || []); setMeta(r || {}); })
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [open, memberId, year]);

  if (!open) return null;

  const totals = meta.totals || {};
  return (
    <div
      className="iu-modal"
      data-testid="comp-off-ledger-modal"
      onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="iu-modal-card max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <header className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Comp-off ledger — {memberName || meta.member_name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {year} · weekly-off <b className="capitalize">{meta.weekly_off || "—"}</b>
              &nbsp;·&nbsp; Earned <b className="text-sky-700">{totals.earned || 0}</b>
              &nbsp;·&nbsp; Applied <b className="text-amber-700">{totals.applied || 0}</b>
              &nbsp;·&nbsp; Approved <b className="text-emerald-700">{totals.approved || 0}</b>
              &nbsp;·&nbsp; Available <b>{totals.available || 0}</b>
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {rows.length > 0 && (
              <button
                onClick={() => downloadBlob(
                  "/reports/comp-off-ledger/export",
                  `comp_off_ledger_${(memberName || "member").replace(/\s+/g, "_")}_${year}.pdf`,
                  { member_id: memberId, year, fmt: "pdf" },
                )}
                className="iu-btn-secondary text-xs"
                data-testid="comp-off-ledger-download-pdf"
                title="Download this ledger as a PDF"
              >
                <Download size={14} /> PDF
              </button>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700 p-1" data-testid="comp-off-ledger-close">
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
            <p className="text-slate-500 text-sm italic">No comp-off activity recorded for {year}.</p>
          ) : (
            <table className="w-full text-xs iu-table-compact">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr className="text-left text-slate-600 font-semibold">
                  <th className="py-1.5">Date</th>
                  <th className="py-1.5">DOW</th>
                  <th className="py-1.5">Kind</th>
                  <th className="py-1.5 text-right">Days</th>
                  <th className="py-1.5">Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.date}-${r.kind}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/60"
                      data-testid={`comp-off-ledger-row-${r.date}-${r.kind}`}>
                    <td className="py-1.5 font-mono">{r.date}</td>
                    <td className="py-1.5 font-semibold text-slate-700">{r.dow}</td>
                    <td className="py-1.5">
                      <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border capitalize ${KIND_TINT[r.kind] || "bg-slate-50 text-slate-600 border-slate-200"}`}>
                        {r.kind}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-bold">{r.qty}</td>
                    <td className="py-1.5 text-slate-600 italic">{r.note || "—"}</td>
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
