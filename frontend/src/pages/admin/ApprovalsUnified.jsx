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
import { Check, ChevronDown, ChevronRight, Coffee, Loader2, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { useAuth } from "../../auth";
import { ApplyForm } from "../MyLeaves";
import { round1 } from "../leaves/utils";
import { BreakForm } from "./Calendar";
import Devices from "./Devices";
import LeaveApprovalConfirmModal from "./LeaveApprovalConfirmModal";
import LeaveContextPanel from "./LeaveContextPanel";
import { BalanceChip, OverrideReasonModal, RejectReasonModal } from "./approvals/ApprovalModals";
import { DecisionHistoryCheckins, DecisionHistoryCorrections, DecisionHistoryLeaves } from "./approvals/DecisionHistory";
import NameFilter from "./approvals/NameFilter";

const nameOf = (r) => r.member_name || r.user_name || "";
import { ElapsedChip, FILTERS, KIND_META, daysBetween, fmtDateTime, normCheckin, normCorrection, normLeave } from "./approvals/rowHelpers";


// --- Component --------------------------------------------------------------

export default function ApprovalsUnified() {
  const { user } = useAuth();
  const isSuper = !!user?.is_super_admin;
  const [filter, setFilter] = useState("all");
  const [nameQ, setNameQ] = useState("");
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
      // Pending device count — powers the "Access Requests" chip badge.
      { queryKey: ["/admin/devices", { status: "pending" }],
        queryFn: () => api.get("/admin/devices", { status_filter: "pending" }) },
    ],
  });
  const [leavesQ, checkinsQ, correctionsQ, checkinsDecidedQ, correctionsDecidedQ, devicesPendingQ] = queries;
  const loading = queries.some((q) => q.isFetching);
  const deviceCount = Array.isArray(devicesPendingQ?.data) ? devicesPendingQ.data.length : 0;

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
    // Blow away all queue caches so a click on "Refresh" or a
    // successful decide() gets fresh data across the board.
    queryClient.invalidateQueries({ queryKey: ["/leaves"] });
    queryClient.invalidateQueries({ queryKey: ["/admin/checkin-approvals"] });
    queryClient.invalidateQueries({ queryKey: ["/admin/corrections"] });
    queryClient.invalidateQueries({ queryKey: ["/admin/devices"] });
    // Approving a correction / leave / check-in rewrites the underlying
    // attendance so every /reports/* view (Grid, Daily, Hours, Payroll…)
    // must refetch — otherwise an approved time-adjust keeps showing the
    // stale "LT" cell on the Grid instead of flipping to "P" (Oct 2026).
    queryClient.invalidateQueries({
      predicate: (q) =>
        typeof q.queryKey?.[0] === "string" && q.queryKey[0].startsWith("/reports/"),
    });
  }, [queryClient]);

  const byName = useCallback((r) => !nameQ || nameOf(r).toLowerCase().includes(nameQ.trim().toLowerCase()), [nameQ]);
  const filteredRows = useMemo(
    () => rows.filter((r) => (filter === "all" || r.kind === filter) && byName(r)),
    [rows, filter, byName]);

  const counts = useMemo(() => {
    const c = { all: rows.length, leave: 0, checkin: 0, correction: 0, device: deviceCount };
    for (const r of rows) c[r.kind] = (c[r.kind] || 0) + 1;
    return c;
  }, [rows, deviceCount]);

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
      // A decision rewrites the underlying attendance/leave data, so every
      // /reports/* view (Grid, Daily, Hours, Payroll…) must refetch —
      // otherwise an approved time-adjust keeps showing the stale "LT" cell
      // on the Grid instead of flipping to "P" (Oct 2026 user report).
      queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey?.[0] === "string" && q.queryKey[0].startsWith("/reports/"),
      });
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

  const allNames = useMemo(() => [...new Set([...rows, ...decidedLeaves, ...decidedCheckins, ...decidedCorrections]
    .map(nameOf).filter((n) => n && n !== "—"))].sort((a, b) => a.localeCompare(b)),
  [rows, decidedLeaves, decidedCheckins, decidedCorrections]);

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

      <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="approvals-filter-chips">
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
        {filter !== "device" && <div className="ml-auto"><NameFilter value={nameQ} onChange={setNameQ} names={allNames} /></div>}
      </div>

      {filter === "device" ? (
        <div data-testid="approvals-devices-embed">
          <Devices embedded />
        </div>
      ) : (
      <>
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
                      {r.two_person ? (
                        <span
                          className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-sky-100 text-sky-700"
                          title={`Attendance change filed by ${r.filer_name || "an admin"} — any other admin can approve`}
                          data-testid={`approvals-second-admin-badge-${r.id}`}
                        >
                          <ShieldAlert size={9}/> 2nd admin
                        </span>
                      ) : r.needs_super_admin && (
                        <span
                          className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-amber-100 text-amber-700"
                          title="Needs Super Admin approval"
                          data-testid={`approvals-superadmin-badge-${r.id}`}
                        >
                          <ShieldAlert size={9}/> Super Admin
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-slate-500 text-xs tabular-nums whitespace-nowrap">
                      {fmtDateTime(r.submitted_at)}
                      <ElapsedChip since={r.submitted_at} testid={`approvals-elapsed-${r.kind}-${r.id}`} />
                    </td>
                    <td className="py-2 px-3 text-slate-700 tabular-nums whitespace-nowrap">{r.when}</td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{r.details || "—"}</td>
                    <td className="py-2 px-3 text-center">
                      {r.two_person && r.filer_id === user?.id ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-2 py-1"
                          title="You filed this attendance change — another admin must approve or reject it"
                          data-testid={`approvals-own-lock-${r.id}`}
                        >
                          <ShieldAlert size={12}/> Another admin approves
                        </span>
                      ) : r.needs_super_admin && !r.two_person && !isSuper ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-1"
                          title="Only a Super Admin can approve or reject this change"
                          data-testid={`approvals-superadmin-lock-${r.id}`}
                        >
                          <ShieldAlert size={12}/> Super Admin only
                        </span>
                      ) : (
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
                      )}
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
        rows={decidedLeaves.filter(byName)}
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
      <DecisionHistoryCheckins rows={decidedCheckins.filter(byName)} />
      <DecisionHistoryCorrections rows={decidedCorrections.filter(byName)} />
      </>
      )}

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
