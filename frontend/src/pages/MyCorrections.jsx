/**
 * MyCorrections — member-facing view of every correction request the
 * signed-in user has raised. Read-only: members can filter by status
 * (Pending / Approved / Rejected) and see the admin's decision + note
 * once acted on. Corrections themselves are still raised from the
 * dedicated modal launched from Check-in / Leaves rows.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, showApiError } from "../api";

const KIND_LABELS = {
  missed_checkin:    "Missed check-in",
  time_adjust:       "Time adjust",
  leave_date_change: "Leave date change",
  leave_cancel:      "Cancel leave",
  leave_type_change: "Change leave type",
};
const KIND_TINT = {
  missed_checkin:    "bg-amber-50 text-amber-800 border-amber-200",
  time_adjust:       "bg-sky-50 text-sky-800 border-sky-200",
  leave_date_change: "bg-violet-50 text-violet-800 border-violet-200",
  leave_cancel:      "bg-rose-50 text-rose-800 border-rose-200",
  leave_type_change: "bg-emerald-50 text-emerald-800 border-emerald-200",
};
const STATUS_TABS = [
  { key: "pending",  label: "Pending",  tint: "bg-amber-100 text-amber-900" },
  { key: "approved", label: "Approved", tint: "bg-emerald-100 text-emerald-900" },
  { key: "rejected", label: "Rejected", tint: "bg-rose-100 text-rose-900" },
];

function summariseChange(row) {
  const p = row.payload || {};
  switch (row.kind) {
    case "missed_checkin":    return `Add attendance ${p.check_in_time || "?"}${p.check_out_time ? " → " + p.check_out_time : ""}`;
    case "time_adjust":       return `Set times to ${p.check_in_time || "—"}${p.check_out_time ? " / " + p.check_out_time : ""}`;
    case "leave_date_change": return `New dates ${p.start_date || "?"} → ${p.end_date || "?"}`;
    case "leave_cancel":      return "Cancel this leave";
    case "leave_type_change": return `Change type to ${p.type || "?"}`;
    default: return "—";
  }
}

export default function MyCorrections() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  // Counts per tab — fetched once (all statuses in parallel) so the pills
  // can surface "how many pending?" without waiting for a tab click.
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/me/corrections?status=${status}`);
      setRows(r || []);
    } catch (err) { showApiError(err, "Load failed"); }
    finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Preload counts for all three status buckets so the tab pills tell
    // members exactly how many items are behind each tab. `Promise.all`
    // fires them in parallel — cheap because /me/corrections is scoped
    // to the current user.
    Promise.all(
      STATUS_TABS.map((t) => api.get(`/me/corrections?status=${t.key}`).then((r) => r?.length || 0).catch(() => 0)),
    ).then(([p, a, r]) => setCounts({ pending: p, approved: a, rejected: r }));
  }, [rows]);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto" data-testid="my-corrections-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">My Corrections</h1>
        <p className="text-slate-500 text-sm mt-1">
          Correction requests you&rsquo;ve raised — missed check-ins, wrong
          times, and leave changes. Admin approves each one; approved
          corrections are applied instantly.
        </p>
      </header>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            data-testid={`my-corr-tab-${t.key}`}
            className={`inline-flex items-center gap-2 px-3 h-9 rounded-full text-xs font-semibold border transition ${
              status === t.key ? "bg-slate-900 text-white border-slate-900"
                               : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >
            {t.label}
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${
              status === t.key ? "bg-white/20 text-white" : t.tint
            }`}>
              {counts[t.key]}
            </span>
          </button>
        ))}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 h-8 rounded-lg text-[11px] font-semibold bg-white border border-slate-200 hover:bg-slate-50"
          data-testid="my-corr-refresh"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-6 text-center text-slate-500 text-sm italic" data-testid="my-corr-empty">
          {status === "pending"
            ? "No pending corrections. Anything you raise from Check-in or Leave/Tour will land here."
            : `No ${status} corrections yet.`}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} data-testid={`my-corr-row-${row.id}`}
                 className="bg-white rounded-lg border border-slate-200 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border ${KIND_TINT[row.kind] || "bg-slate-50 text-slate-700 border-slate-200"}`}>
                  {KIND_LABELS[row.kind] || row.kind}
                </span>
                <span className="text-xs text-slate-500">Target date <b className="text-slate-800">{row.target_date}</b></span>
                <span className="text-xs text-slate-400 ml-auto">
                  Raised {row.requested_at?.slice(0, 16).replace("T", " ")}
                </span>
              </div>
              <div className="text-sm text-slate-800 mt-1.5 font-semibold">{summariseChange(row)}</div>
              {row.reason && (
                <div className="text-xs text-slate-600 italic mt-1">&ldquo;{row.reason}&rdquo;</div>
              )}
              {row.status !== "pending" && (
                <div className={`text-[11px] mt-2 pt-2 border-t border-slate-100 ${
                  row.status === "approved" ? "text-emerald-700" : "text-rose-700"
                }`}>
                  {row.status === "approved" ? "✓ Approved" : "✗ Rejected"}
                  {row.decided_by_name && ` by ${row.decided_by_name}`}
                  {row.decided_at && ` · ${row.decided_at.slice(0, 16).replace("T", " ")}`}
                  {row.admin_note && <span className="text-slate-600"> · &ldquo;{row.admin_note}&rdquo;</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
