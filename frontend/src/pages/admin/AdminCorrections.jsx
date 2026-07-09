/**
 * AdminCorrections — the "Corrections" tab on the /admin/approvals page.
 * Lists every pending (or approved/rejected) correction request from
 * members, lets the admin approve or reject each, and offers a bulk
 * "Approve all pending" button (skips any that error out and reports
 * skipped count in the toast).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Check, X, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";

// Short human labels for the correction kinds — mirrors the modal.
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
  { key: "pending",  label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export default function AdminCorrections() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/corrections?status=${status}`);
      setRows(r || []);
    } catch (err) { showApiError(err, "Load failed"); }
    finally { setLoading(false); }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const decide = async (row, decision) => {
    setBusyId(row.id);
    try {
      await api.post(`/admin/corrections/${row.id}/decide`, {
        status: decision,
        admin_note: notes[row.id] || "",
      });
      toast.success(decision === "approved" ? "Approved" : "Rejected");
      load();
    } catch (err) { showApiError(err, "Decision failed"); }
    finally { setBusyId(null); }
  };

  const approveAll = async () => {
    const n = rows.length;
    if (!n) return;
    if (!window.confirm(`Approve ALL ${n} pending correction${n === 1 ? "" : "s"}?`)) return;
    setBusyId("bulk");
    try {
      const r = await api.post("/admin/corrections/approve-all", {});
      const skipped = r?.skipped || 0;
      toast.success(`Approved ${r.approved}${skipped ? ` · ${skipped} skipped (target rows changed)` : ""}`);
      load();
    } catch (err) { showApiError(err, "Bulk approve failed"); }
    finally { setBusyId(null); }
  };

  // One-liner summary of the payload — what the correction WILL do when approved.
  const summariseChange = (row) => {
    const p = row.payload || {};
    switch (row.kind) {
      case "missed_checkin":
        return `Add attendance ${p.check_in_time || "?"}${p.check_out_time ? " → " + p.check_out_time : ""}`;
      case "time_adjust":
        return `Set times to ${p.check_in_time || "—"}${p.check_out_time ? " / " + p.check_out_time : ""}`;
      case "leave_date_change":
        return `New dates ${p.start_date || "?"} → ${p.end_date || "?"}`;
      case "leave_cancel":
        return "Cancel this leave";
      case "leave_type_change":
        return `Change type to ${p.type || "?"}`;
      default:
        return "—";
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 flex-wrap">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            data-testid={`corr-tab-${t.key}`}
            className={`px-3 h-8 rounded-full text-xs font-semibold border transition ${
              status === t.key ? "bg-slate-800 text-white border-slate-800"
                                : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
            }`}
          >{t.label}</button>
        ))}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[11px] font-semibold bg-white border border-slate-200 hover:bg-slate-50"
          data-testid="corr-refresh"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
        {status === "pending" && rows.length > 0 && (
          <button
            onClick={approveAll}
            disabled={busyId === "bulk"}
            className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            data-testid="corr-approve-all"
          >
            {busyId === "bulk" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Approve all ({rows.length})
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-slate-500 text-sm italic">No {status} corrections.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} data-testid={`corr-row-${row.id}`}
                 className="bg-white rounded-lg border border-slate-200 p-3 flex flex-col md:flex-row md:items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex px-2 h-5 rounded-full text-[10px] font-bold border ${KIND_TINT[row.kind] || "bg-slate-50 text-slate-700 border-slate-200"}`}>
                    {KIND_LABELS[row.kind] || row.kind}
                  </span>
                  <span className="text-sm font-semibold text-slate-800">{row.requester_name}</span>
                  <span className="text-xs text-slate-500">· {row.target_date}</span>
                  {row.filed_by_admin_id && (
                    <span
                      className="inline-flex items-center gap-1 px-2 h-5 rounded-full text-[10px] font-bold bg-sky-50 text-sky-800 border border-sky-200"
                      title={`Filed on behalf by ${row.filed_by_admin_name}`}
                      data-testid={`corr-filed-by-admin-${row.id}`}
                    >
                      Filed by admin: {row.filed_by_admin_name}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-700 mt-1">{summariseChange(row)}</div>
                <div className="text-xs text-slate-600 italic mt-1">“{row.reason}”</div>
                {row.status !== "pending" && (
                  <div className="text-[11px] text-slate-500 mt-1">
                    {row.status === "approved" ? "✓" : "✗"} by {row.decided_by_name} · {row.decided_at?.slice(0, 16).replace("T", " ")}
                    {row.admin_note && ` · ${row.admin_note}`}
                  </div>
                )}
              </div>
              {row.status === "pending" && (
                <div className="flex items-center gap-2 md:w-96 shrink-0">
                  <input
                    type="text"
                    placeholder="Admin note (optional)"
                    value={notes[row.id] || ""}
                    onChange={(e) => setNotes((n) => ({ ...n, [row.id]: e.target.value }))}
                    className="iu-input !h-8 text-xs flex-1"
                    data-testid={`corr-note-${row.id}`}
                  />
                  <button
                    onClick={() => decide(row, "approved")}
                    disabled={busyId === row.id}
                    className="iu-btn-primary !h-8 !px-3 text-xs"
                    data-testid={`corr-approve-${row.id}`}
                  >
                    {busyId === row.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Approve
                  </button>
                  <button
                    onClick={() => decide(row, "rejected")}
                    disabled={busyId === row.id}
                    className="iu-btn-ghost !h-8 !px-3 text-xs text-rose-600 border-rose-200"
                    data-testid={`corr-reject-${row.id}`}
                  >
                    <X size={12} /> Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
