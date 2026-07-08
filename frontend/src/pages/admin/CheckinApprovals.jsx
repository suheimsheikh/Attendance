/**
 * CheckinApprovals — review queue for late & off-geofence check-ins.
 *
 * Every check-in stamped `approval_status="pending"` (i.e. late OR
 * out_of_geofence) lands here. Admins can approve or reject; both
 * decisions are note-only per policy — the attendance row stays valid
 * and still counts in reports. This screen just puts an audit-trail
 * eyeball on anomalies.
 *
 * Renders inline inside `/admin/approvals?tab=checkins`.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  Loader2, RefreshCw, AlertTriangle, MapPin, Clock,
  Check, X, Camera, Filter,
} from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import Avatar from "../../components/Avatar";

const STATUS_TABS = [
  { key: "pending",  label: "Pending",  tone: "amber" },
  { key: "approved", label: "Approved", tone: "emerald" },
  { key: "rejected", label: "Rejected", tone: "rose" },
];

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString([], {
      day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function fmtDistance(m) {
  if (m == null) return null;
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function FlagChips({ row }) {
  const flags = row.approval_flags || {};
  const chips = [];
  if (flags.late) {
    chips.push(
      <span key="late" className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
        <Clock size={9} /> Late +{row.late_minutes ?? "?"}m
      </span>
    );
  }
  if (flags.out_of_geofence) {
    const d = fmtDistance(row.distance_m);
    chips.push(
      <span key="off" className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold bg-rose-100 text-rose-800 border border-rose-200">
        <MapPin size={9} /> Off-site{d ? ` · ${d}` : ""}
      </span>
    );
  }
  return <div className="flex flex-wrap gap-1 mt-1">{chips}</div>;
}

function DecideRow({ row, onDecide, working }) {
  const [note, setNote] = useState("");
  const [expanded, setExpanded] = useState(false);
  const isPending = row.approval_status === "pending";

  const submit = async (decision) => {
    if (decision === "rejected" && note.trim().length < 3) {
      toast.error("A note (≥3 chars) is required when rejecting.");
      return;
    }
    await onDecide(row.id, decision, note.trim() || null);
    setNote("");
    setExpanded(false);
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid={`checkin-approval-row-${row.id}`}>
      <div className="flex items-start gap-3">
        <Avatar name={row.full_name} photo={row.photo_thumb} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-900 truncate">{row.full_name || "Unknown"}</span>
            <span className="text-[11px] text-slate-500 tabular-nums">
              {fmtTime(row.check_in_at)}
            </span>
            {row.site_name && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 h-4 rounded bg-emerald-50 border border-emerald-200 text-emerald-700">
                <MapPin size={8} /> {row.site_name}
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {[row.institution, row.fleet, row.category, row.method === "muster" ? `via ${row.checked_in_by}` : row.method]
              .filter(Boolean).join(" · ")}
          </div>
          <FlagChips row={row} />
          {row.geo_reason && (
            <div className="mt-1.5 text-[11px] text-slate-700 bg-slate-50 rounded px-2 py-1 italic border border-slate-100">
              <b>Member said:</b> {row.geo_reason}
            </div>
          )}
          {row.approval_status !== "pending" && (
            <div className="mt-1.5 text-[11px] text-slate-600">
              <b>{row.approval_status === "approved" ? "Approved" : "Rejected"}</b>
              {row.approved_by ? <> by {row.approved_by}</> : null}
              {row.approved_at ? <> · {fmtTime(row.approved_at)}</> : null}
              {row.approval_note ? <> · <i>&ldquo;{row.approval_note}&rdquo;</i></> : null}
            </div>
          )}
        </div>

        {isPending && (
          <div className="flex flex-col gap-1.5 shrink-0 items-end">
            {!expanded ? (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => submit("approved")}
                  disabled={working}
                  className="inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  data-testid={`checkin-approve-${row.id}`}
                >
                  <Check size={13} /> Approve
                </button>
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  disabled={working}
                  className="inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-xs font-semibold bg-white border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                  data-testid={`checkin-reject-open-${row.id}`}
                >
                  <X size={13} /> Reject
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5 w-full sm:w-64">
                <textarea
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Reason for rejection (required, kept in audit trail)"
                  className="w-full text-xs rounded-lg border border-slate-300 p-1.5 outline-none focus:border-rose-500"
                  autoFocus
                  data-testid={`checkin-reject-note-${row.id}`}
                />
                <div className="flex gap-1.5 justify-end">
                  <button
                    type="button"
                    onClick={() => { setExpanded(false); setNote(""); }}
                    className="px-2 h-7 rounded-lg text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => submit("rejected")}
                    disabled={working || note.trim().length < 3}
                    className="px-2.5 h-7 rounded-lg text-[11px] font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                    data-testid={`checkin-reject-confirm-${row.id}`}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function CheckinApprovals() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/checkin-approvals?status=${status}`);
      setRows(r.items || []);
    } catch (err) {
      showApiError(err, "Couldn't load check-in approvals");
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const decide = async (id, decision, note) => {
    setWorking(true);
    try {
      await api.post(`/admin/checkin-approvals/${id}/decide`, { decision, note });
      toast.success(decision === "approved" ? "Approved" : "Rejected — noted for record");
      load();
    } catch (err) {
      showApiError(err, "Decision failed");
    } finally {
      setWorking(false);
    }
  };

  const approveAll = async () => {
    const count = rows.length;
    if (count === 0) return;
    if (!window.confirm(`Approve ALL ${count} pending check-in${count === 1 ? "" : "s"}? This is auditable but not undoable per row.`)) return;
    setWorking(true);
    try {
      const r = await api.post("/admin/checkin-approvals/approve-all", {});
      toast.success(`Approved ${r.updated} check-in${r.updated === 1 ? "" : "s"}`);
      load();
    } catch (err) {
      showApiError(err, "Bulk approve failed");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div data-testid="checkin-approvals-tab">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1">
          <Filter size={11} /> Show
        </span>
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
              status === t.key
                ? "bg-slate-900 text-white border-transparent"
                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
            data-testid={`checkin-status-${t.key}`}
          >
            {t.label}
          </button>
        ))}
        <button
          onClick={load}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[11px] font-semibold bg-white border border-slate-200 hover:bg-slate-50"
          data-testid="checkin-approvals-refresh"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Refresh
        </button>
        {/* Bulk-approve is only relevant on the Pending tab; hidden elsewhere
            to avoid confusion. Confirms before firing (irreversible per-row). */}
        {status === "pending" && rows.length > 0 && (
          <button
            onClick={approveAll}
            disabled={working || loading}
            className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-lg text-[11px] font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            data-testid="checkin-approvals-approve-all"
            title={`Approve all ${rows.length} pending check-ins`}
          >
            <Check size={12} /> Approve all ({rows.length})
          </button>
        )}
      </div>

      {loading && rows.length === 0 ? (
        <div className="py-8 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="checkin-approvals-empty">
          <Camera size={28} className="mx-auto text-slate-300 mb-2" />
          <p className="text-sm text-slate-500">
            {status === "pending"
              ? "🎉 No pending check-in reviews — clean slate!"
              : `No ${status} check-ins yet.`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <DecideRow key={r.id} row={r} onDecide={decide} working={working} />
          ))}
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-4 flex items-start gap-1">
        <AlertTriangle size={11} className="mt-0.5 shrink-0" />
        Both decisions are note-only. Rejected check-ins still count in reports; the rejection is recorded in the audit trail for future policy calls.
      </p>
    </div>
  );
}
