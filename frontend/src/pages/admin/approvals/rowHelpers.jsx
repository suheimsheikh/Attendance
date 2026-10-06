import { LogIn, PencilRuler, Plane } from "lucide-react";
import { api } from "../../../api";
import { formatDate, formatTime } from "../../../utils";

export const KIND_META = {
  leave:      { label: "Leave/Tour",  Icon: Plane,          tone: "bg-amber-100 text-amber-700" },
  checkin:    { label: "Check-in",    Icon: LogIn,          tone: "bg-sky-100 text-sky-700" },
  correction: { label: "Correction",  Icon: PencilRuler,    tone: "bg-violet-100 text-violet-700" },
};

// OT approval tab removed 15 Feb 2026 — overtime is now a purely
// calculated field (see /reports/ot-ledger + The Grid OT column).
export const FILTERS = [
  { key: "all",        label: "All" },
  { key: "leave",      label: "Leaves" },
  { key: "checkin",    label: "Check-ins" },
  { key: "correction", label: "Corrections" },
  // Device/phone access approvals — consolidated onto this page (Jun 2026,
  // user request) so the standalone "Access Requests" menu item could be
  // removed. Renders the full Devices workflow inline (approve-to-create
  // member, revoke, reinstate) rather than as unified-table rows.
  { key: "device",     label: "Access Requests" },
];

export function fmtDateTime(iso) {
  if (!iso) return "";
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

export function daysBetween(start, end) {
  try {
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    return Math.round((e - s) / 86400000) + 1;
  } catch { return null; }
}

// --- Per-type normalisers ---------------------------------------------------

// "Waiting Nd" chip — how long a request has sat in the queue. Amber
// from 3 days, red from 7 so stale leave applications stand out.
export function ElapsedChip({ since, testid }) {
  if (!since) return null;
  const days = Math.floor((Date.now() - new Date(since).getTime()) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  const tone = days >= 7 ? "bg-rose-100 text-rose-700" : days >= 3 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600";
  const label = days === 0 ? "today" : `${days}d ago`;
  return (
    <span className={`ml-1.5 inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold ${tone}`} title={`Applied ${days} day${days === 1 ? "" : "s"} ago`} data-testid={testid}>
      {label}
    </span>
  );
}

export function normLeave(row) {
  const days = daysBetween(row.start_date, row.end_date);
  return {
    kind: "leave",
    id: row.id,
    member_name: row.member_name || row.user_name || "—",
    submitted_at: row.created_at || row.applied_at || row.start_date,
    // Include the weekday so weekend (Sat/Sun) leave requests jump out
    // at the approver — user request, Jun 2026.
    when: `${formatDate(row.start_date)}${row.end_date && row.end_date !== row.start_date ? ` → ${formatDate(row.end_date)}` : ""}`,
    details: [
      (row.type || "leave").toUpperCase(),
      days ? `${days}d` : null,
      row.short_notice ? (row.short_notice_lop ? "⚠ short-notice → LOP" : "short notice") : null,
      row.filed_by_admin_name ? `filed by ${row.filed_by_admin_name}` : null,
      row.reason,
    ].filter(Boolean).join(" · "),
    // Raw dates + user_id so the expandable LeaveContextPanel can fetch
    // overlapping leaves / regattas / camps for the same window.
    context: {
      id: row.id,
      user_id: row.user_id,
      start_date: row.start_date,
      end_date: row.end_date || row.start_date,
    },
    // Feb 2026: expose the full leave doc so the pending row can show
    // an inline "X days available" chip (checks balanceMap[user_id])
    // and the Decision-history table can render turnaround +
    // denial_reason + balance/YTD snapshot fields returned by the
    // /leaves API.
    raw: row,
    apply: async (decision, extra = {}) => {
      const body = { status: decision === "approve" ? "approved" : "rejected", ...extra };
      await api.patch(`/leaves/${row.id}`, body);
    },
  };
}

// OT approval removed 15 Feb 2026 — helper deleted along with the tab.


export function normCheckin(row) {
  return {
    kind: "checkin",
    id: row.id,
    member_name: row.user_name || row.member_name || "—",
    submitted_at: row.requested_at || row.check_in_at,
    when: `${formatDate(row.date)} · ${formatTime(row.check_in_at)}`,
    details: [
      row.method ? row.method.toUpperCase() : null,
      row.geofence_status || (row.distance_m ? `${Math.round(row.distance_m)}m from site` : null),
      row.reason,
    ].filter(Boolean).join(" · "),
    raw: row,
    apply: async (decision, extra = {}) => {
      // Backend requires `note` (>= 3 chars) on rejection — Slice 3
      // makes the frontend surface the same modal used for leaves so
      // the requester always has an audit trail.
      const note = extra.denial_reason || "";
      await api.post(`/admin/checkin-approvals/${row.id}/decide`, {
        decision: decision === "approve" ? "approved" : "rejected",
        note,
      });
    },
  };
}

export function normCorrection(row) {
  const isBulk = row.kind === "bulk_delete";
  const p = row.payload || {};
  return {
    kind: "correction",
    id: row.id,
    member_name: isBulk ? "⚠ Bulk deletion" : (row.requester_name || "—"),
    submitted_at: row.requested_at,
    when: isBulk ? `${formatDate(row.target_date)} · raised by ${row.requester_name || "admin"}` : formatDate(row.target_date),
    // Attendance change filed by an admin — awaiting Super Admin sign-off.
    needs_super_admin: !!row.needs_super_admin,
    details: isBulk
      ? [p.label || p.tool, p.affected_rows != null ? `${p.affected_rows} row${p.affected_rows === 1 ? "" : "s"} will be deleted` : null, row.reason].filter(Boolean).join(" · ")
      : [
        ({ member_delete: "Delete member", member_archive: "Archive member" }[row.kind]) || (row.kind || "").replace(/_/g, " "),
        p.check_in_time ? `in ${p.check_in_time}` : null,
        p.check_out_time ? `out ${p.check_out_time}` : null,
        row.filed_by_admin_name ? `filed by ${row.filed_by_admin_name}` : null,
        row.reason,
      ].filter(Boolean).join(" · "),
    raw: row,
    apply: async (decision, extra = {}) => {
      const body = { status: decision === "approve" ? "approved" : "rejected" };
      // Slice 3: rejection reason lives on `admin_note` for
      // corrections (see corrections.py CorrectionDecision model).
      if (decision === "reject" && extra.denial_reason) {
        body.admin_note = extra.denial_reason;
      }
      await api.post(`/admin/corrections/${row.id}/decide`, body);
    },
  };
}
