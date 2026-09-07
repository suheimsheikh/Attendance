/**
 * ApprovalsUnified — one table for every pending approval type
 * (leaves / tours / overtime / check-ins / corrections).
 *
 * Shipped 10 Feb 2026 per user request: "Can we combine all approvals
 * into one table". Replaces the 4-tab wrapper — tabs became filter
 * chips above a single date-sorted (latest first) table.
 *
 * Fetches from the four existing per-type endpoints in parallel, then
 * normalises each row into a common shape:
 *   { kind, id, member_name, submitted_at, when_label, details, apply }
 * `apply(decision)` is a closure that fires the type-specific
 * approve/reject endpoint so the table stays type-agnostic.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Check, X, Plane, LogIn, PencilRuler, Plus, Coffee, ChevronDown, ChevronRight, History, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { formatDate, formatTime, dayOfWeek, shortDate } from "../../utils";
import { ApplyForm } from "../MyLeaves";
import { BreakForm } from "./Calendar";
import LeaveContextPanel from "./LeaveContextPanel";
import LeaveApprovalConfirmModal from "./LeaveApprovalConfirmModal";
import { round1 } from "../leaves/utils";

const KIND_META = {
  leave:      { label: "Leave/Tour",  Icon: Plane,          tone: "bg-amber-100 text-amber-700" },
  checkin:    { label: "Check-in",    Icon: LogIn,          tone: "bg-sky-100 text-sky-700" },
  correction: { label: "Correction",  Icon: PencilRuler,    tone: "bg-violet-100 text-violet-700" },
};

// OT approval tab removed 15 Feb 2026 — overtime is now a purely
// calculated field (see /reports/ot-ledger + The Grid OT column).
const FILTERS = [
  { key: "all",        label: "All" },
  { key: "leave",      label: "Leaves" },
  { key: "checkin",    label: "Check-ins" },
  { key: "correction", label: "Corrections" },
];

function fmtDateTime(iso) {
  if (!iso) return "";
  return `${formatDate(iso)} · ${formatTime(iso)}`;
}

function daysBetween(start, end) {
  try {
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    return Math.round((e - s) / 86400000) + 1;
  } catch { return null; }
}

// --- Per-type normalisers ---------------------------------------------------

function normLeave(row) {
  const days = daysBetween(row.start_date, row.end_date);
  return {
    kind: "leave",
    id: row.id,
    member_name: row.member_name || row.user_name || "—",
    submitted_at: row.created_at || row.applied_at || row.start_date,
    // Include the weekday so weekend (Sat/Sun) leave requests jump out
    // at the approver — user request, Jun 2026.
    when: `${dayOfWeek(row.start_date)} ${formatDate(row.start_date)}${row.end_date && row.end_date !== row.start_date ? ` → ${dayOfWeek(row.end_date)} ${formatDate(row.end_date)}` : ""}`,
    details: [
      (row.type || "leave").toUpperCase(),
      days ? `${days}d` : null,
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


function normCheckin(row) {
  return {
    kind: "checkin",
    id: row.id,
    member_name: row.user_name || row.member_name || "—",
    submitted_at: row.requested_at || row.check_in_at,
    when: `${dayOfWeek(row.date)} ${formatDate(row.date)} · ${formatTime(row.check_in_at)}`,
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

function normCorrection(row) {
  return {
    kind: "correction",
    id: row.id,
    member_name: row.requester_name || "—",
    submitted_at: row.requested_at,
    when: `${dayOfWeek(row.target_date)} ${formatDate(row.target_date)}`,
    details: [
      (row.kind || "").replace(/_/g, " "),
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

// --- Component --------------------------------------------------------------

export default function ApprovalsUnified() {
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState(null);
  const queryClient = useQueryClient();

  // "Apply on behalf" + "Apply break" modals — moved onto this page
  // 20 Feb 2026 after the sidebar "Leave & Tour" nav was removed and
  // admins reported they could no longer find how to file a leave for a
  // member. The old /admin/leaves-page route still works but the two
  // primary admin CTAs now live where they'll be found.
  const [showOnBehalf, setShowOnBehalf] = useState(false);
  const [showBreak, setShowBreak] = useState(false);
  const [breakDeps, setBreakDeps] = useState({ members: [], institutions: [] });
  // Expanded leave rows show a contextual sub-row with overlapping
  // leaves + regattas + camps. Keyed by leave id — one at a time is
  // fine, but the Set gives cheap multi-open without lifting the
  // panel state.
  const [expandedLeaves, setExpandedLeaves] = useState(new Set());
  const toggleExpand = useCallback((id) => {
    setExpandedLeaves((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  // Two-step approval guard for LEAVES only (24 Feb 2026 user request).
  // First Approve click parks the row here; the modal shows the full
  // context and requires a second confirm to fire the decision.
  // Rejections stay one-click — the safety net is only on the "yes"
  // path where a stray click could grant an absence during a
  // scheduled regatta / camp.
  const [pendingConfirm, setPendingConfirm] = useState(null);

  // Rejection-with-reason modal (Feb 2026 spec) — backend now REQUIRES
  // `denial_reason` on any leave rejection so the applicant can see
  // *why* on their own list. Modal is scoped to leaves; check-in and
  // correction rejects stay one-click (their backends don't require
  // a reason yet).
  const [rejectTarget, setRejectTarget] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);

  // Balance-override modal (Feb 2026 · Slice 2) — when approving a
  // LEAVE whose requested days exceed the applicant's live pool the
  // backend now returns 400 unless `override_reason` is on the body.
  // We do a client-side pre-check on `balanceMap` and surface this
  // modal so admins can approve LOP-triggering leaves knowingly.
  const [overrideTarget, setOverrideTarget] = useState(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideBusy, setOverrideBusy] = useState(false);

  // Per-applicant leave-summary cache. Keyed by user_id. Populated
  // lazily as the leave rows render, so the inline "X days available"
  // chip appears without blocking the initial pending fetch.
  const [balanceMap, setBalanceMap] = useState({});

  const openBreakModal = useCallback(async () => {
    setShowBreak(true);
    if (breakDeps.members.length === 0) {
      try {
        const [members, institutions] = await Promise.all([
          api.get("/members").catch(() => []),
          api.get("/institutions").catch(() => []),
        ]);
        setBreakDeps({ members: members || [], institutions: institutions || [] });
      } catch (err) {
        console.debug("Break modal pre-load failed (non-blocking):", err);
      }
    }
  }, [breakDeps.members.length]);

  // Three independent queues rendered in one table. `useQueries` lets us
  // cache each response individually — a decision on a leave invalidates
  // only its queue, not the whole page. Failures are per-queue: a 500
  // on /leaves must not blank out check-ins & corrections (was the root
  // of the "sidebar 82 pending, list empty" phantom-badge prod bug —
  // 20 Feb 2026).
  const queries = useQueries({
    queries: [
      { queryKey: ["/leaves", null], queryFn: () => api.get("/leaves") },
      { queryKey: ["/admin/checkin-approvals", { status: "pending" }],
        queryFn: () => api.get("/admin/checkin-approvals", { status: "pending" }) },
      { queryKey: ["/admin/corrections", { status: "pending" }],
        queryFn: () => api.get("/admin/corrections", { status: "pending" }) },
      // Slice 3 (Feb 2026) — decided rows for each queue so we can
      // render Decision-history tables under each pending grid. Keep
      // as separate queries (rather than one giant fetch) so the
      // pending queue stays snappy on page entry.
      { queryKey: ["/admin/checkin-approvals", { status: "decided" }],
        queryFn: async () => {
          const [a, r] = await Promise.all([
            api.get("/admin/checkin-approvals", { status: "approved" }).catch(() => []),
            api.get("/admin/checkin-approvals", { status: "rejected" }).catch(() => []),
          ]);
          return [...(a || []), ...(r || [])];
        } },
      { queryKey: ["/admin/corrections", { status: "decided" }],
        queryFn: async () => {
          const [a, r] = await Promise.all([
            api.get("/admin/corrections", { status: "approved" }).catch(() => []),
            api.get("/admin/corrections", { status: "rejected" }).catch(() => []),
          ]);
          return [...(a || []), ...(r || [])];
        } },
    ],
  });
  const [leavesQ, checkinsQ, correctionsQ, checkinsDecidedQ, correctionsDecidedQ] = queries;
  const loading = queries.some((q) => q.isFetching);

  // Surface any queue-level failures via toast, keyed by label so a stale
  // toast doesn't linger after a subsequent successful refetch.
  useEffect(() => {
    const failures = [
      { q: leavesQ, label: "leaves" },
      { q: checkinsQ, label: "check-ins" },
      { q: correctionsQ, label: "corrections" },
    ].filter((x) => x.q.error);
    for (const { q, label } of failures) {
      console.warn(`[approvals] ${label} endpoint failed`, q.error);
      toast.error(`Couldn't load ${label} — showing the rest`);
    }
    // Deps: only re-fire when error identity changes on any queue.
  }, [leavesQ.error, checkinsQ.error, correctionsQ.error, leavesQ, checkinsQ, correctionsQ]);

  const rows = useMemo(() => {
    const asArray = (r) => Array.isArray(r) ? r : (r?.items || r?.rows || []);
    const safeMap = (arr, fn, label) => {
      const out = [];
      for (const [i, row] of arr.entries()) {
        try { out.push(fn(row)); } catch (e) {
          console.warn(`[approvals] ${label}[${i}] threw`, e, row);
        }
      }
      return out;
    };
    const leavesData = leavesQ.data ? asArray(leavesQ.data).filter((l) => l.status === "pending") : [];
    const checkinsData = checkinsQ.data ? asArray(checkinsQ.data) : [];
    const correctionsData = correctionsQ.data ? asArray(correctionsQ.data) : [];
    const merged = [
      ...safeMap(leavesData, normLeave, "leave"),
      ...safeMap(checkinsData, normCheckin, "checkin"),
      ...safeMap(correctionsData, normCorrection, "correction"),
    ];
    merged.sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""));
    return merged;
  }, [leavesQ.data, checkinsQ.data, correctionsQ.data]);

  const load = useCallback(() => {
    // Blow away all three queue caches so a click on "Refresh" or a
    // successful decide() gets fresh data across the board.
    queryClient.invalidateQueries({ queryKey: ["/leaves"] });
    queryClient.invalidateQueries({ queryKey: ["/admin/checkin-approvals"] });
    queryClient.invalidateQueries({ queryKey: ["/admin/corrections"] });
  }, [queryClient]);

  const filteredRows = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => r.kind === filter);
  }, [rows, filter]);

  const counts = useMemo(() => {
    const c = { all: rows.length, leave: 0, checkin: 0, correction: 0 };
    for (const r of rows) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }, [rows]);

  const decide = async (row, decision) => {
    // Two-step guard: first Approve click on a LEAVE row opens the
    // confirmation modal instead of firing. The second click (inside
    // the modal) re-enters `decide` with `confirmed: true` and
    // proceeds. Rejects bypass the guard entirely.
    if (decision === "approve" && row.kind === "leave" && row.context && !row._confirmed) {
      setPendingConfirm(row);
      return;
    }
    // Balance-override intercept (Slice 2). Backend 400s if requested >
    // available on a `type=leave`. Client-side pre-check keeps the UX
    // smooth — we ask the admin here rather than showing a raw 400
    // toast.
    if (decision === "approve"
        && row.kind === "leave"
        && row.raw?.type === "leave"
        && !row._overrideReason) {
      const bal = balanceMap[row.context?.user_id];
      if (bal && !bal.error) {
        const avail = round1((bal.comp_off?.available || 0) + (bal.paid_leave?.available || 0));
        const req = daysBetween(row.context.start_date, row.context.end_date) || 1;
        const requested = row.raw?.half_day ? 0.5 : req;
        if (requested > avail + 1e-9) {
          setOverrideTarget({ ...row, _requested: requested, _available: avail });
          setOverrideReason("");
          return;
        }
      }
    }
    // Rejection requires a reason for ALL kinds (leaves / check-ins /
    // corrections) — Slice 3 unifies the flow so the requester always
    // has an audit trail. Divert into the reason modal on any first
    // reject click.
    if (decision === "reject" && !row._rejectReason) {
      setRejectTarget(row);
      setRejectReason("");
      return;
    }
    setBusyId(`${row.kind}-${row.id}-${decision}`);
    try {
      const extra = decision === "reject" && row._rejectReason
        ? { denial_reason: row._rejectReason }
        : (decision === "approve" && row._overrideReason
            ? { override_reason: row._overrideReason }
            : {});
      await row.apply(decision, extra);
      toast.success(`${decision === "approve" ? "Approved" : "Rejected"}: ${row.member_name}`);
      // Optimistic: yank the row out of its per-queue cache so admins
      // don't wait on the refetch to see it disappear. Then trigger a
      // background refetch for authoritative state + summary sync.
      const dropRow = (arr) => {
        if (!Array.isArray(arr)) return arr;
        return arr.filter((x) => (x.id ?? x._id) !== row.id);
      };
      if (row.kind === "leave") {
        // For leaves we invalidate rather than drop, because the
        // Decision-history table below the pending grid needs to pick
        // up the freshly-decided row (with its new denial_reason /
        // snapshot fields) at the top.
        queryClient.invalidateQueries({ queryKey: ["/leaves"] });
      } else if (row.kind === "checkin") {
        queryClient.setQueryData(
          ["/admin/checkin-approvals", { status: "pending" }],
          (prev) => {
            if (!prev) return prev;
            if (Array.isArray(prev)) return dropRow(prev);
            const items = dropRow(prev.items || prev.rows || []);
            return { ...prev, items, count: items.length };
          },
        );
      } else if (row.kind === "correction") {
        queryClient.setQueryData(
          ["/admin/corrections", { status: "pending" }],
          dropRow,
        );
      }
      // Refresh the sidebar badge count without spamming other tabs.
      queryClient.invalidateQueries({ queryKey: ["/admin/approvals-summary"] });
    } catch (err) {
      showApiError(err, `Could not ${decision}`);
      // Roll back any optimistic drop by refetching the queue.
      if (row.kind === "leave") queryClient.invalidateQueries({ queryKey: ["/leaves"] });
      else if (row.kind === "checkin") queryClient.invalidateQueries({ queryKey: ["/admin/checkin-approvals"] });
      else if (row.kind === "correction") queryClient.invalidateQueries({ queryKey: ["/admin/corrections"] });
    } finally { setBusyId(null); }
  };

  const submitReject = useCallback(async () => {
    const reason = rejectReason.trim();
    if (!reason || !rejectTarget) {
      toast.error("Please write a short reason so the applicant knows why");
      return;
    }
    setRejectBusy(true);
    try {
      // Re-enter decide() with the reason attached so it goes straight
      // through the API and the same optimistic-cache / toast path
      // fires (keeps behaviour identical to check-in / correction
      // rejects modulo the reason).
      await decide({ ...rejectTarget, _rejectReason: reason }, "reject");
      setRejectTarget(null);
      setRejectReason("");
    } finally {
      setRejectBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rejectReason, rejectTarget]);

  const submitOverride = useCallback(async () => {
    const reason = overrideReason.trim();
    if (!reason || !overrideTarget) {
      toast.error("Please write a short justification for the LOP override");
      return;
    }
    setOverrideBusy(true);
    try {
      await decide(
        { ...overrideTarget, _overrideReason: reason, _confirmed: true },
        "approve",
      );
      setOverrideTarget(null);
      setOverrideReason("");
    } finally {
      setOverrideBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideReason, overrideTarget]);

  // Batch-fetch each pending leave applicant's live leave-summary so
  // the balance chip on the row can flag shortfall approvals at a
  // glance. One fetch per unique user_id — cached in balanceMap.
  useEffect(() => {
    const pendingLeaves = (leavesQ.data || []).filter((l) => l.status === "pending" && l.user_id);
    const uniqueIds = Array.from(new Set(pendingLeaves.map((l) => l.user_id)));
    const missing = uniqueIds.filter((uid) => !balanceMap[uid]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      await Promise.all(
        missing.map(async (uid) => {
          try {
            const r = await api.get(`/members/${uid}/leave-summary`);
            if (!cancelled) setBalanceMap((m) => ({ ...m, [uid]: r }));
          } catch {
            if (!cancelled) setBalanceMap((m) => ({ ...m, [uid]: { error: true } }));
          }
        }),
      );
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leavesQ.data]);

  // Decision history — decided leaves only, latest first. Wraps the
  // raw /leaves rows since they already carry the snapshot fields we
  // need to render (balance_at_decision, ytd_applied_days,
  // ytd_denied_days, denial_reason, decided_by, decided_at). Sliced
  // out here so the rendering below stays declarative.
  const decidedLeaves = useMemo(() => {
    return (leavesQ.data || [])
      .filter((l) => l.status === "approved" || l.status === "rejected")
      .sort((a, b) => (b.decided_at || "").localeCompare(a.decided_at || ""));
  }, [leavesQ.data]);

  // Slice 3: decided lists for check-ins & corrections. Both endpoints
  // return the concatenated approved + rejected arrays via the
  // pre-defined queries; we just sort newest-first here.
  const decidedCheckins = useMemo(() => {
    const arr = Array.isArray(checkinsDecidedQ.data) ? checkinsDecidedQ.data : [];
    return [...arr].sort((a, b) =>
      (b.approval_decided_at || b.decided_at || b.approval_at || "").localeCompare(
        a.approval_decided_at || a.decided_at || a.approval_at || "",
      ),
    );
  }, [checkinsDecidedQ.data]);

  const decidedCorrections = useMemo(() => {
    const arr = Array.isArray(correctionsDecidedQ.data) ? correctionsDecidedQ.data : [];
    return [...arr].sort((a, b) =>
      (b.decided_at || "").localeCompare(a.decided_at || ""),
    );
  }, [correctionsDecidedQ.data]);

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto" data-testid="approvals-unified">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Approvals</h1>
          <p className="text-slate-500 text-sm mt-1">
            One table for every pending request — sorted latest first.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={openBreakModal}
            title="Log a short mid-day break for a member (auto-approved)"
            className="iu-btn-secondary !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200"
            data-testid="apply-break"
          >
            <Coffee size={14}/> Apply break
          </button>
          <button
            onClick={() => setShowOnBehalf(true)}
            title="File a leave, tour or late arrival for a member who can't do it themselves"
            className="iu-btn-primary"
            data-testid="apply-on-behalf"
          >
            <Plus size={14}/> Apply on behalf
          </button>
          <button
            onClick={load}
            title="Reload the pending queue from the server"
            className="iu-btn-secondary"
            disabled={loading}
            data-testid="approvals-refresh"
          >
            {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Refresh
          </button>
        </div>
      </header>

      <div className="flex flex-wrap gap-2 mb-4" data-testid="approvals-filter-chips">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = counts[f.key] || 0;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              title={`Show only ${f.label.toLowerCase()} requests`}
              className={`iu-chip ${active ? "iu-chip-active" : ""}`}
              data-testid={`approvals-filter-${f.key}`}
            >
              {f.label}
              <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${
                active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"
              }`}>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">          <table className="w-full text-sm" data-testid="approvals-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Member</th>
                <th className="py-2 px-3 text-left">Kind</th>
                <th className="py-2 px-3 text-left">Submitted</th>
                <th className="py-2 px-3 text-left">When</th>
                <th className="py-2 px-3 text-left">Details</th>
                <th className="py-2 px-3 text-center w-40">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && filteredRows.length === 0 && (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`appr-skel-${i}`} className="border-b border-slate-100" data-testid="approvals-skeleton-row">
                    <td className="py-2 px-3" colSpan={6}>
                      <div className="h-4 rounded bg-slate-200/70 animate-pulse w-full" />
                    </td>
                  </tr>
                ))
              )}
              {!loading && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400" data-testid="approvals-empty">
                    Nothing pending in this filter. 🎉
                  </td>
                </tr>
              )}
              {filteredRows.map((r) => {
                const meta = KIND_META[r.kind] || {};
                const Icon = meta.Icon;
                const isLeave = r.kind === "leave" && r.context;
                const isExpanded = isLeave && expandedLeaves.has(r.id);
                return (
                  <React.Fragment key={`${r.kind}-${r.id}`}>
                  <tr className="border-b border-slate-100 hover:bg-slate-50 transition-colors" data-testid={`approvals-row-${r.kind}-${r.id}`}>
                    <td className="py-2 px-3 font-semibold text-slate-800">
                      <div className="flex items-center gap-1">
                        {isLeave ? (
                          <button
                            onClick={() => toggleExpand(r.id)}
                            className="p-0.5 rounded hover:bg-slate-200 text-slate-500 shrink-0"
                            title={isExpanded ? "Hide context" : "Show overlapping leaves, regattas & camps"}
                            data-testid={`approvals-expand-${r.id}`}
                          >
                            {isExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
                          </button>
                        ) : (
                          <span className="w-[18px] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate">{r.member_name}</div>
                          {isLeave && r.raw?.type === "leave" && (
                            <BalanceChip
                              data={balanceMap[r.context.user_id]}
                              requestedDays={r.raw?.half_day
                                ? 0.5
                                : (daysBetween(r.context.start_date, r.context.end_date) || 1)}
                              testid={`balance-chip-${r.id}`}
                            />
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${meta.tone || "bg-slate-100 text-slate-600"}`}>
                        {Icon && <Icon size={11}/>} {meta.label || r.kind}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-500 text-xs tabular-nums whitespace-nowrap">{fmtDateTime(r.submitted_at)}</td>
                    <td className="py-2 px-3 text-slate-700 tabular-nums whitespace-nowrap">{r.when}</td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{r.details || "—"}</td>
                    <td className="py-2 px-3 text-center">
                      <div className="inline-flex gap-1.5">
                        <button
                          onClick={() => decide(r, "approve")}
                          disabled={!!busyId}
                          className="p-1.5 rounded-md bg-emerald-50 hover:bg-emerald-100 text-emerald-700 disabled:opacity-40"
                          title="Approve"
                          data-testid={`approvals-approve-${r.kind}-${r.id}`}
                        >
                          {busyId === `${r.kind}-${r.id}-approve` ? <Loader2 size={14} className="animate-spin"/> : <Check size={14}/>}
                        </button>
                        <button
                          onClick={() => decide(r, "reject")}
                          disabled={!!busyId}
                          className="p-1.5 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 disabled:opacity-40"
                          title="Reject"
                          data-testid={`approvals-reject-${r.kind}-${r.id}`}
                        >
                          {busyId === `${r.kind}-${r.id}-reject` ? <Loader2 size={14} className="animate-spin"/> : <X size={14}/>}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr data-testid={`approvals-context-row-${r.id}`}>
                      <td colSpan={6} className="p-0">
                        <LeaveContextPanel leave={r.context} />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- Decision history (leaves + checkins + corrections) --- */}
      <DecisionHistoryLeaves
        rows={decidedLeaves}
        onReopen={async (leaveId) => {
          try {
            await api.patch(`/leaves/${leaveId}`, { status: "pending" });
            toast.success("Moved back to pending");
            queryClient.invalidateQueries({ queryKey: ["/leaves"] });
            queryClient.invalidateQueries({ queryKey: ["/admin/approvals-summary"] });
          } catch (err) {
            showApiError(err, "Could not re-open");
          }
        }}
      />
      <DecisionHistoryCheckins rows={decidedCheckins} />
      <DecisionHistoryCorrections rows={decidedCorrections} />

      {showOnBehalf && (
        <ApplyForm
          asAdmin
          onClose={() => setShowOnBehalf(false)}
          onCreated={() => {
            setShowOnBehalf(false);
            // Fresh leaves cache so newly-filed on-behalf rows appear
            // in the pending list without a manual refresh.
            queryClient.invalidateQueries({ queryKey: ["/leaves"] });
            queryClient.invalidateQueries({ queryKey: ["/admin/approvals-summary"] });
          }}
        />
      )}
      {showBreak && (
        <BreakForm
          members={breakDeps.members}
          institutions={breakDeps.institutions}
          onClose={() => setShowBreak(false)}
          onSaved={() => { setShowBreak(false); toast.success("Break applied"); }}
        />
      )}
      {pendingConfirm && (
        <LeaveApprovalConfirmModal
          row={pendingConfirm}
          busy={busyId === `${pendingConfirm.kind}-${pendingConfirm.id}-approve`}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={async () => {
            const row = pendingConfirm;
            setPendingConfirm(null);
            // Re-enter decide() with a flag that bypasses the guard.
            // Wrapping in a plain object with `_confirmed` is cheaper
            // than lifting the guard-bypass logic to a separate
            // function and keeps `row.apply` intact.
            await decide({ ...row, _confirmed: true }, "approve");
          }}
        />
      )}
      {rejectTarget && (
        <RejectReasonModal
          row={rejectTarget}
          reason={rejectReason}
          onReasonChange={setRejectReason}
          busy={rejectBusy}
          onCancel={() => { setRejectTarget(null); setRejectReason(""); }}
          onSubmit={submitReject}
        />
      )}
      {overrideTarget && (
        <OverrideReasonModal
          row={overrideTarget}
          reason={overrideReason}
          onReasonChange={setOverrideReason}
          busy={overrideBusy}
          onCancel={() => { setOverrideTarget(null); setOverrideReason(""); }}
          onSubmit={submitOverride}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BalanceChip — inline "X days available" pill under the member name on
// pending LEAVE rows. Colour flips to rose when the requested days would
// exceed the paid-leave + comp-off pool, so admins can spot LOP-triggering
// approvals at a glance without expanding the context panel.
// ---------------------------------------------------------------------------
function BalanceChip({ data, requestedDays, testid }) {
  if (!data) {
    return (
      <div className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-slate-400" data-testid={testid}>
        <Loader2 size={9} className="animate-spin" /> balance…
      </div>
    );
  }
  if (data.error) return null;
  const co = data.comp_off?.available || 0;
  const pl = data.paid_leave?.available || 0;
  const total = round1(co + pl);
  const shortfall = requestedDays > total;
  return (
    <div
      className={`mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
        shortfall ? "bg-rose-100 text-rose-700" : "bg-emerald-50 text-emerald-700"
      }`}
      data-testid={testid}
      title={shortfall
        ? `Only ${total} day(s) available for ${requestedDays} requested — approving will trigger LOP`
        : `${total} day(s) available (${co} comp-off + ${round1(pl)} paid leave)`}
    >
      {shortfall ? <AlertTriangle size={9} /> : <Check size={9} />}
      {total} avail
    </div>
  );
}

// ---------------------------------------------------------------------------
// RejectReasonModal — mandatory denial reason on a leave rejection. Sent
// as `denial_reason` on the PATCH so the applicant sees "why" when they
// check their own leave list. Kept inline (no separate file) because the
// modal lifecycle is tightly coupled to the parent's decide() flow.
// ---------------------------------------------------------------------------
// Common denial reasons — a small dropdown pre-fills the textarea so
// admins can reject in one click while still capturing an audit trail.
// Admin can still type a fresh reason on top of, or in place of, the
// suggestion. Per-kind lists so a check-in reject doesn't show
// leave-specific suggestions.
const REJECT_SUGGESTIONS = {
  leave: [
    "Camp overlap — please re-plan",
    "Regatta duty during this window",
    "Insufficient balance — apply comp-off first",
    "Advance notice too short",
    "Peak workload — no cover available",
  ],
  checkin: [
    "Off-geofence without valid reason",
    "Wrong location",
    "Late arrival — no supporting evidence",
    "Selfie / method inconsistent with muster",
  ],
  correction: [
    "Wrong entity — please re-file against the correct row",
    "Incorrect date",
    "Duplicate request — already actioned",
    "Insufficient supporting details",
  ],
};

function RejectReasonModal({ row, reason, onReasonChange, busy, onCancel, onSubmit }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" data-testid="reject-modal">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-extrabold text-slate-900">Reject request</h3>
          <p className="text-xs text-slate-500 mt-1">
            {row.member_name} · {row.when}
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider" htmlFor="reject-reason">
            Reason for rejection *
          </label>
          {(REJECT_SUGGESTIONS[row.kind] || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="reject-suggestions">
              {REJECT_SUGGESTIONS[row.kind].map((s) => {
                const active = reason.trim() === s;
                return (
                  <button
                    key={s}
                    type="button"
                    data-testid={`reject-suggestion-${s.slice(0, 20).replace(/[^a-z0-9]/gi, "-").toLowerCase()}`}
                    onClick={() => onReasonChange(s)}
                    className={`text-[11px] px-2 py-1 rounded-full border transition ${
                      active
                        ? "bg-rose-600 text-white border-rose-600"
                        : "bg-white text-slate-700 border-slate-300 hover:bg-rose-50 hover:border-rose-300"
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
              <button
                type="button"
                data-testid="reject-suggestion-clear"
                onClick={() => onReasonChange("")}
                className="text-[11px] px-2 py-1 rounded-full border border-transparent text-slate-500 hover:text-slate-800 hover:underline"
              >
                Clear
              </button>
            </div>
          )}
          <textarea
            id="reject-reason"
            data-testid="reject-reason-input"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
            placeholder="Tap a common reason above, or write a fresh one here"
          />
          <p className="text-[11px] text-slate-500">
            The applicant will see this on their own list — please be specific.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button
            type="button"
            data-testid="reject-modal-cancel"
            onClick={onCancel}
            disabled={busy}
            className="iu-btn-secondary !h-9 !px-3 !text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="reject-modal-confirm"
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="iu-btn-primary !h-9 !px-3 !text-sm !bg-rose-600 hover:!bg-rose-700"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            Reject request
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OverrideReasonModal — mandatory LOP override reason on Approve when the
// applicant's balance falls short of the requested days. Copies the visual
// pattern of RejectReasonModal but frames the action positively (Approve
// with LOP) and hard-shows the shortfall so admins can't miss it.
// ---------------------------------------------------------------------------
function OverrideReasonModal({ row, reason, onReasonChange, busy, onCancel, onSubmit }) {
  const requested = row._requested;
  const available = row._available;
  const shortfall = round1(Math.max(0, requested - available));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" data-testid="override-modal">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-100 bg-amber-50/70">
          <h3 className="text-lg font-extrabold text-amber-900 inline-flex items-center gap-2">
            <AlertTriangle size={18} /> Balance shortfall — approve with LOP?
          </h3>
          <p className="text-xs text-amber-800 mt-1">
            {row.member_name} · {row.when}
          </p>
          <p className="text-[11px] text-amber-800 mt-2">
            Requesting <strong>{requested}</strong> day(s) but only <strong>{available}</strong> available.
            Approving will LOP <strong className="uppercase">{shortfall} day{shortfall === 1 ? "" : "s"}</strong>.
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider" htmlFor="override-reason">
            Justification for the override *
          </label>
          <textarea
            id="override-reason"
            data-testid="override-reason-input"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            placeholder="e.g. Bereavement — approving as LOP with the member's consent"
          />
          <p className="text-[11px] text-slate-500">
            Recorded on the leave audit trail as `approval_override_reason` for future reference.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" data-testid="override-modal-cancel" onClick={onCancel} disabled={busy} className="iu-btn-secondary !h-9 !px-3 !text-sm">Cancel</button>
          <button
            type="button"
            data-testid="override-modal-confirm"
            onClick={onSubmit}
            disabled={busy || !reason.trim()}
            className="iu-btn-primary !h-9 !px-3 !text-sm !bg-amber-600 hover:!bg-amber-700"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Approve with LOP
          </button>
        </div>
      </div>
    </div>
  );
}

// decided leave we surface every field from the pending grid PLUS the
// four new audit fields snapshotted on PATCH:
//   • turnaround (applied → decided) — computed client-side from the two ISO stamps
//   • denial_reason                 — set only for rejects
//   • balance_at_decision           — { paid_leave_available, comp_off_available }
//   • ytd_applied_days / ytd_denied_days
// ---------------------------------------------------------------------------
function fmtTurnaround(fromIso, toIso) {
  if (!fromIso || !toIso) return "—";
  try {
    const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  } catch { return "—"; }
}

const STATUS_TONE = {
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-slate-200 text-slate-700",
};

function computeHistoryStats(rows) {
  let approved = 0, rejected = 0, lop = 0, tSum = 0, tN = 0;
  for (const l of rows) {
    if (l.status === "approved") approved++;
    else if (l.status === "rejected") rejected++;
    if (typeof l.lop_days === "number") lop += l.lop_days;
    if (l.created_at && l.decided_at) {
      const ms = new Date(l.decided_at).getTime() - new Date(l.created_at).getTime();
      if (Number.isFinite(ms) && ms >= 0) { tSum += ms; tN++; }
    }
  }
  const avgMs = tN ? tSum / tN : 0;
  const avgH = avgMs / 3600000;
  return {
    total: rows.length,
    approved, rejected, lop: round1(lop),
    avgTurnaround: avgH >= 24 ? `${(avgH / 24).toFixed(1)}d` : (avgH >= 1 ? `${avgH.toFixed(1)}h` : `${Math.round(avgMs / 60000)}m`),
  };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadDecisionHistoryCsv(rows) {
  const header = ["Member","Category","Type","Half day","Start","End","Days","Applied on",
    "Reason for applying","Status","Decided by","Decided on","Turnaround",
    "Denial reason","LOP override","Balance @ decision","Applied YTD","Denied YTD","LOP days"];
  const lines = [header.map(csvEscape).join(",")];
  for (const l of rows) {
    const days = l.half_day ? 0.5 : (daysBetween(l.start_date, l.end_date) ?? "");
    const bal = l.balance_at_decision;
    const balTotal = bal ? round1((bal.paid_leave_available || 0) + (bal.comp_off_available || 0)) : "";
    lines.push([
      l.member_name || "", l.member_category || "",
      (l.type || "").toUpperCase(), l.half_day || "",
      l.start_date || "", l.end_date || "", days,
      l.created_at ? l.created_at.slice(0, 10) : "",
      l.reason || "", l.status || "",
      l.decided_by || "",
      l.decided_at ? l.decided_at.slice(0, 10) : "",
      fmtTurnaround(l.created_at, l.decided_at),
      l.denial_reason || "", l.approval_override_reason || "",
      balTotal,
      typeof l.ytd_applied_days === "number" ? l.ytd_applied_days : "",
      typeof l.ytd_denied_days === "number" ? l.ytd_denied_days : "",
      typeof l.lop_days === "number" ? l.lop_days : "",
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `leave-decisions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function StatPill({ label, value, tone = "slate", testid }) {
  const toneMap = {
    slate: "bg-white text-slate-900 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    violet: "bg-violet-50 text-violet-900 border-violet-200",
  };
  return (
    <div className={`px-3 py-1.5 rounded-md border ${toneMap[tone]}`} data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-lg font-extrabold tabular-nums leading-none mt-0.5">{value}</div>
    </div>
  );
}

function DecisionHistoryLeaves({ rows, onReopen }) {
  const stats = computeHistoryStats(rows);
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Leaves</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">
          No approved or rejected leave requests yet.
        </div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history">
      <div className="flex items-center gap-2 mb-2 text-slate-500 flex-wrap">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Leaves</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top)
        </span>
        <div className="ml-auto">
          <button
            type="button"
            data-testid="history-export-csv"
            onClick={() => downloadDecisionHistoryCsv(rows)}
            className="iu-btn-secondary !h-8 !px-3 !text-xs"
            title="Download all decisions in this view as CSV"
          >
            Download CSV
          </button>
        </div>
      </div>

      {/* Violet-tinted "history box" so admins can tell at a glance
          they're looking at decided rows, not the pending queue above. */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3" data-testid="history-box">
        {/* Stats strip at the top of the history box. */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3" data-testid="history-stats">
          <StatPill testid="stat-total"     label="Total"       value={stats.total}         tone="violet" />
          <StatPill testid="stat-approved"  label="Approved"    value={stats.approved}      tone="emerald" />
          <StatPill testid="stat-rejected"  label="Rejected"    value={stats.rejected}      tone="rose" />
          <StatPill testid="stat-lop"       label="LOP days"    value={stats.lop || 0}      tone="amber" />
          <StatPill testid="stat-avg"       label="Avg turnaround" value={stats.avgTurnaround} tone="slate" />
        </div>

        <div className="rounded-md bg-white border border-violet-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] table-fixed" data-testid="decision-history-table">
              <colgroup>
                <col style={{ width: "13%" }} />{/* Member */}
                <col style={{ width: "6%"  }} />{/* Type */}
                <col style={{ width: "12%" }} />{/* Dates */}
                <col style={{ width: "4%"  }} />{/* Days */}
                <col style={{ width: "14%" }} />{/* Reason applied */}
                <col style={{ width: "6%"  }} />{/* Status */}
                <col style={{ width: "12%" }} />{/* Decided (by/on) */}
                <col style={{ width: "6%"  }} />{/* Turnaround */}
                <col style={{ width: "15%" }} />{/* Denial / Override */}
                <col style={{ width: "4%"  }} />{/* Bal */}
                <col style={{ width: "4%"  }} />{/* YTD app */}
                <col style={{ width: "4%"  }} />{/* YTD den */}
              </colgroup>
              <thead className="bg-violet-100/60 border-b border-violet-200 text-violet-900 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="py-1.5 px-2 text-left">Member</th>
                  <th className="py-1.5 px-2 text-left">Type</th>
                  <th className="py-1.5 px-2 text-left">Dates</th>
                  <th className="py-1.5 px-2 text-right">Days</th>
                  <th className="py-1.5 px-2 text-left">Reason</th>
                  <th className="py-1.5 px-2 text-left">Status</th>
                  <th className="py-1.5 px-2 text-left" title="Decided by · Decided on">Decided</th>
                  <th className="py-1.5 px-2 text-left" title="Applied → Decided">T/A</th>
                  <th className="py-1.5 px-2 text-left" title="Denial reason or LOP override note">Note</th>
                  <th className="py-1.5 px-2 text-right" title="Balance at decision (paid + comp)">Bal</th>
                  <th className="py-1.5 px-2 text-right" title="YTD days applied">A</th>
                  <th className="py-1.5 px-2 text-right" title="YTD days denied">D</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const days = daysBetween(l.start_date, l.end_date);
                  const bal = l.balance_at_decision;
                  const balTotal = bal
                    ? round1((bal.paid_leave_available || 0) + (bal.comp_off_available || 0))
                    : null;
                  const statusTone = STATUS_TONE[l.status] || "bg-slate-100 text-slate-700";
                  const note = l.status === "rejected"
                    ? l.denial_reason
                    : l.approval_override_reason;
                  const noteTone = l.status === "rejected" ? "text-rose-700" : "text-amber-700";
                  return (
                    <tr
                      key={l.id}
                      data-testid={`history-row-${l.id}`}
                      className="border-b border-violet-100/60 hover:bg-violet-50/50"
                      onDoubleClick={() => onReopen(l.id)}
                      title="Double-click to re-open"
                    >
                      <td className="py-1.5 px-2 truncate">
                        <div className="font-semibold text-slate-800 truncate">{l.member_name}</div>
                        <div className="text-[10px] text-slate-500 truncate">{l.member_category || ""}</div>
                      </td>
                      <td className="py-1.5 px-2">
                        <span className="inline-block px-1.5 h-4 leading-4 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-800">
                          {(l.type || "leave").slice(0, 4).toUpperCase()}
                        </span>
                        {l.half_day && (
                          <div className="mt-0.5 text-[9px] font-bold text-sky-700">½ · {l.half_day}</div>
                        )}
                      </td>
                      <td className="py-1.5 px-2 whitespace-nowrap font-mono text-[10px] text-slate-700">
                        {shortDate(l.start_date)}
                        {l.end_date && l.end_date !== l.start_date && <> → {shortDate(l.end_date)}</>}
                        <div className="text-[9px] text-slate-400">app {shortDate(l.created_at)}</div>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums">
                        {l.half_day ? "0.5" : (days ?? "—")}
                      </td>
                      <td className="py-1.5 px-2 text-[11px] text-slate-700">
                        <div className="line-clamp-2" title={l.reason}>
                          {l.reason || <span className="text-slate-300">—</span>}
                        </div>
                      </td>
                      <td className="py-1.5 px-2">
                        <span className={`inline-block px-1.5 h-4 leading-4 rounded-full text-[10px] font-bold ${statusTone}`}>
                          {l.status === "approved" ? "OK" : "REJ"}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-[11px] text-slate-700">
                        <div className="truncate" title={l.decided_by || ""}>{l.decided_by || <span className="text-slate-300">—</span>}</div>
                        <div className="text-[10px] text-slate-500 whitespace-nowrap">{l.decided_at ? shortDate(l.decided_at) : ""}</div>
                      </td>
                      <td className="py-1.5 px-2 text-[10px] font-mono text-slate-600 whitespace-nowrap">
                        {fmtTurnaround(l.created_at, l.decided_at)}
                      </td>
                      <td className="py-1.5 px-2 text-[11px]">
                        {note
                          ? <div className={`line-clamp-2 ${noteTone}`} title={note}>{note}</div>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {balTotal != null
                          ? <span title={`${bal.comp_off_available ?? 0} comp + ${bal.paid_leave_available ?? 0} paid`}>{balTotal}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {typeof l.ytd_applied_days === "number" ? l.ytd_applied_days : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {typeof l.ytd_denied_days === "number" ? l.ytd_denied_days : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-violet-800/70">
          Double-click any row to re-open it. Hover cells for full text — long values are truncated to fit.
        </p>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Decision history — Check-ins. Simpler than leaves: no balance / YTD
// fields, no re-open (check-ins aren't reversible), but the columns
// still mirror the pending grid + audit fields.
// ---------------------------------------------------------------------------
function DecisionHistoryCheckins({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-checkins-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Check-ins</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">No decided check-in requests yet.</div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history-checkins">
      <div className="flex items-center gap-2 mb-2 text-slate-500">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Check-ins</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top — {rows.length} decision{rows.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]" data-testid="decision-history-checkins-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Member</th>
                <th className="py-2 px-3 text-left">Date · Time</th>
                <th className="py-2 px-3 text-left">Method · Geofence</th>
                <th className="py-2 px-3 text-left">Reason for applying</th>
                <th className="py-2 px-3 text-left w-24">Status</th>
                <th className="py-2 px-3 text-left">Decided by</th>
                <th className="py-2 px-3 text-left w-24">Decided on</th>
                <th className="py-2 px-3 text-left w-20">Turnaround</th>
                <th className="py-2 px-3 text-left">Denial note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const decidedAt = r.approval_decided_at || r.decided_at || r.approval_at;
                const submittedAt = r.requested_at || r.check_in_at;
                const status = r.approval_status || r.status;
                const tone = status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700";
                return (
                  <tr key={r.id} data-testid={`history-checkin-row-${r.id}`} className="border-b border-slate-100 hover:bg-sky-50/40">
                    <td className="py-2 px-3 font-semibold text-slate-800">{r.user_name || r.member_name || "—"}</td>
                    <td className="py-2 px-3 whitespace-nowrap text-slate-700 text-xs">
                      {r.date && dayOfWeek(r.date)} {r.date && formatDate(r.date)} · {r.check_in_at && formatTime(r.check_in_at)}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">
                      {[r.method?.toUpperCase(), r.geofence_status || (r.distance_m ? `${Math.round(r.distance_m)}m from site` : null)]
                        .filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="py-2 px-3 text-slate-700 text-xs max-w-[240px]">
                      <div className="line-clamp-2" title={r.reason}>{r.reason || <span className="text-slate-300">—</span>}</div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${tone}`}>
                        {status === "approved" ? "Approved" : "Rejected"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs font-semibold text-slate-700">
                      {r.approval_by_name || r.decided_by || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-600 whitespace-nowrap">
                      {decidedAt ? shortDate(decidedAt) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-[11px] font-mono text-slate-600">
                      {fmtTurnaround(submittedAt, decidedAt)}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-700 max-w-[240px]">
                      {status === "rejected" && r.approval_note
                        ? <div className="line-clamp-2 text-rose-700" title={r.approval_note}>{r.approval_note}</div>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision history — Corrections. Column set mirrors leaves minus the
// balance / YTD snapshot (corrections don't touch the leave pool).
// ---------------------------------------------------------------------------
function DecisionHistoryCorrections({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-corrections-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Corrections</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">No decided correction requests yet.</div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history-corrections">
      <div className="flex items-center gap-2 mb-2 text-slate-500">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Corrections</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top — {rows.length} decision{rows.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]" data-testid="decision-history-corrections-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Requester</th>
                <th className="py-2 px-3 text-left">Kind</th>
                <th className="py-2 px-3 text-left">Target date</th>
                <th className="py-2 px-3 text-left">Reason for applying</th>
                <th className="py-2 px-3 text-left w-24">Status</th>
                <th className="py-2 px-3 text-left">Decided by</th>
                <th className="py-2 px-3 text-left w-24">Decided on</th>
                <th className="py-2 px-3 text-left w-20">Turnaround</th>
                <th className="py-2 px-3 text-left">Denial note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tone = r.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700";
                return (
                  <tr key={r.id} data-testid={`history-correction-row-${r.id}`} className="border-b border-slate-100 hover:bg-sky-50/40">
                    <td className="py-2 px-3 font-semibold text-slate-800">{r.requester_name || "—"}</td>
                    <td className="py-2 px-3 text-xs text-slate-600 capitalize">
                      {(r.kind || "").replace(/_/g, " ")}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap text-slate-700 text-xs">
                      {r.target_date && `${dayOfWeek(r.target_date)} ${formatDate(r.target_date)}`}
                    </td>
                    <td className="py-2 px-3 text-slate-700 text-xs max-w-[240px]">
                      <div className="line-clamp-2" title={r.reason}>{r.reason || <span className="text-slate-300">—</span>}</div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${tone}`}>
                        {r.status === "approved" ? "Approved" : "Rejected"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs font-semibold text-slate-700">
                      {r.decided_by_name || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-600 whitespace-nowrap">
                      {r.decided_at ? shortDate(r.decided_at) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-[11px] font-mono text-slate-600">
                      {fmtTurnaround(r.requested_at, r.decided_at)}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-700 max-w-[240px]">
                      {r.status === "rejected" && r.admin_note
                        ? <div className="line-clamp-2 text-rose-700" title={r.admin_note}>{r.admin_note}</div>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

