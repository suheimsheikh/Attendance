import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Check, X, AlertTriangle, Plus, Coffee, ChevronDown, ChevronUp, Users, RefreshCw, Bed, History } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { shortDate } from "../../utils";
import { ApplyForm } from "../MyLeaves";
import { round1 } from "../leaves/utils";
import { BreakForm } from "./Calendar";
import OverlapNotice from "../../components/OverlapNotice";
import EventConflictNotice from "../../components/EventConflictNotice";
import ConflictAcknowledgeModal from "../../components/ConflictAcknowledgeModal";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "late", label: "Late applications" },
];

// Visual mapping for the Type column. Keeps row JSX terse.
const TYPE_META = {
  leave:       { label: "Leave",       cls: "bg-amber-100 text-amber-800" },
  tour:        { label: "Tour",        cls: "bg-orange-100 text-orange-800" },
  posting:     { label: "POSTED",      cls: "bg-sky-100 text-sky-800" },
  comp_off:    { label: "Comp Off",    cls: "bg-violet-100 text-violet-800" },
  late_coming: { label: "Late",        cls: "bg-rose-100 text-rose-800" },
};
const STATUS_META = {
  pending:  { label: "Pending",  cls: "bg-amber-100 text-amber-800",   order: 0 },
  approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800", order: 1 },
  rejected: { label: "Rejected", cls: "bg-slate-200 text-slate-700",   order: 2 },
};

function daysInclusive(start, end) {
  try {
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    return Math.max(1, Math.floor((e - s) / 86400000) + 1);
  } catch { return 1; }
}

export default function AdminLeaves({ embedded = false }) {
  const [filter, setFilter] = useState("all");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showOnBehalf, setShowOnBehalf] = useState(false);
  const [showBreak, setShowBreak] = useState(false);
  const [breakDeps, setBreakDeps] = useState({ members: [], institutions: [] });
  // Per-row expansion: shows overlap (who else is on leave) + the
  // applicant's live leave-balance pools. Lazy — we don't fetch a
  // balance until the row is opened.
  const [expandedId, setExpandedId] = useState(null);
  const [balanceMap, setBalanceMap] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Always fetch ALL — sort + filter client-side so we can group by
      // status (Pending first) WITHOUT a round-trip on every filter chip.
      setItems(await api.get("/leaves"));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Apply the active chip + the group-by-status priority sort.
  const visible = (items || [])
    .filter((l) => {
      if (filter === "all") return true;
      if (filter === "late") return l.late_application;
      return l.status === filter;
    })
    .sort((a, b) => {
      const sa = STATUS_META[a.status]?.order ?? 9;
      const sb = STATUS_META[b.status]?.order ?? 9;
      if (sa !== sb) return sa - sb;
      // Newest application first within each status bucket.
      return (b.created_at || "").localeCompare(a.created_at || "");
    });

  // Slice the list once so the Pending grid and the Decision-history
  // grid can render off the same fetch. History = anything with a
  // `decided_at` (i.e. approved or rejected), sorted by decision-time
  // DESC — freshly decided rows show at the top of the history panel
  // right after the admin makes the decision, and the grid below the
  // Pending table matches the "latest first" spec from Feb 2026.
  const pendingRows = visible.filter((l) => l.status === "pending");
  const decidedRows = (items || [])
    .filter((l) => l.status === "approved" || l.status === "rejected")
    .filter((l) => {
      // Respect the same top-level chip so the two grids stay in step.
      if (filter === "all" || filter === "late") return true;
      return l.status === filter;
    })
    .sort((a, b) => (b.decided_at || "").localeCompare(a.decided_at || ""));

  // Batch-fetch each pending applicant's live leave-summary so we can
  // show a small "X days available" chip inline on their row (before
  // the admin has expanded the detail row). One fetch per unique
  // user_id — cached on `balanceMap`.
  useEffect(() => {
    const uniqueIds = Array.from(new Set(pendingRows.map((l) => l.user_id).filter(Boolean)));
    const missing = uniqueIds.filter((uid) => !balanceMap[uid]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      await Promise.all(
        missing.map(async (uid) => {
          try {
            const r = await api.get(`/members/${uid}/leave-summary`);
            if (!cancelled) setBalanceMap((m) => ({ ...m, [uid]: r }));
          } catch (err) {
            if (!cancelled) setBalanceMap((m) => ({ ...m, [uid]: { error: true } }));
          }
        }),
      );
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Lazy-load members + institutions only when admin opens the Apply Break
  // modal — keeps the leaves list snappy on every page entry.
  const openBreakModal = async () => {
    setShowBreak(true);
    if (breakDeps.members.length === 0) {
      try {
        const [members, institutions] = await Promise.all([
          api.get("/members").catch(() => []),
          api.get("/institutions").catch(() => []),
        ]);
        setBreakDeps({ members: members || [], institutions: institutions || [] });
      } catch (err) {
        // Non-blocking — the inner .catch(() => []) clauses already
        // handle network failures cleanly; this outer block only catches
        // truly unexpected errors (e.g. setState after unmount). Log so
        // we can spot regressions but don't surface a toast to the admin.
        console.debug("Break modal pre-load failed (non-blocking):", err);
      }
    }
  };

  // Approval-gate modal state (2 Feb 2026): when a pending leave has
  // any overlapping camps/regattas, we intercept the Approve click,
  // fetch conflicts, and force the admin to tick "I've reviewed the
  // conflicts" before the patch fires. Rejects and re-opens are never
  // gated — this is purely an *approval* safety net.
  const [confirmGate, setConfirmGate] = useState(null); // { leave, conflicts }
  const [confirmBusy, setConfirmBusy] = useState(false);

  const decide = async (id, status, extra = {}) => {
    try {
      await api.patch(`/leaves/${id}`, { status, ...extra });
      toast.success(`Request ${status}`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  // Rejection flow: mandatory denial reason captured in a small modal
  // so the applicant always has an audit trail of WHY it was turned
  // down (Feb 2026 spec). We keep the pending decide() path for
  // approvals (which doesn't need a reason) unchanged.
  const [rejectTarget, setRejectTarget] = useState(null); // leave row
  const [rejectReason, setRejectReason] = useState("");
  const [rejectBusy, setRejectBusy] = useState(false);
  const startReject = (leave) => {
    setRejectTarget(leave);
    setRejectReason("");
  };
  const submitReject = async () => {
    const reason = rejectReason.trim();
    if (!reason) {
      toast.error("Please write a short reason so the applicant knows why");
      return;
    }
    setRejectBusy(true);
    try {
      await decide(rejectTarget.id, "rejected", { denial_reason: reason });
      setRejectTarget(null);
      setRejectReason("");
    } finally {
      setRejectBusy(false);
    }
  };

  const startApprove = async (leave) => {
    // Only leave/tour/posting have "during the period" semantics worth
    // gating — late-coming is same-day and comp-off has no overlap.
    const gatedTypes = ["leave", "tour", "posting"];
    if (!gatedTypes.includes(leave.type)) {
      return decide(leave.id, "approved");
    }
    setConfirmBusy(true);
    try {
      const res = await api.get("/leaves/event-conflicts", {
        start_date: leave.start_date,
        end_date: leave.end_date,
        user_id: leave.user_id,
      });
      const camps = res?.camps || [];
      const regattas = res?.regattas || [];
      if (camps.length === 0 && regattas.length === 0) {
        // Clean approve — no conflicts, no modal.
        await decide(leave.id, "approved");
      } else {
        setConfirmGate({ leave, camps, regattas });
      }
    } catch (err) {
      // Conflict lookup failed — don't block the admin's workflow; log
      // and fall through to a normal approve so the button stays usable.
      console.debug("event-conflicts lookup failed", err);
      await decide(leave.id, "approved");
    } finally {
      setConfirmBusy(false);
    }
  };

  // Lazily fetch the unified balance summary (comp-off + paid leave) for a
  // single applicant — only when the admin clicks Details on their row.
  // The summary is cached client-side under member_id so reopening is
  // instant and re-decisions don't re-hit the API.
  const fetchBalance = useCallback(async (userId) => {
    if (!userId || balanceMap[userId]) return;
    try {
      const r = await api.get(`/members/${userId}/leave-summary`);
      setBalanceMap((m) => ({ ...m, [userId]: r }));
    } catch (err) {
      console.debug("balance fetch failed", err);
      setBalanceMap((m) => ({ ...m, [userId]: { error: true } }));
    }
  }, [balanceMap]);

  const toggleExpand = (leave) => {
    if (expandedId === leave.id) {
      setExpandedId(null);
    } else {
      setExpandedId(leave.id);
      fetchBalance(leave.user_id);
    }
  };

  // When mounted inside the Approvals tab container, drop the page padding +
  // page-level h1 (the wrapper already renders them) but keep the "Apply on
  // behalf" CTA + the filter chips above the list.
  return (
    <div className={embedded ? "" : "p-4 md:p-8 max-w-5xl mx-auto"}>
      {!embedded && (
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Leave Approvals</h1>
            <p className="text-slate-500 text-sm mt-1">Review and decide on leave & tour requests.</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button data-testid="apply-break" onClick={openBreakModal} title="Log a short mid-day break for a member (auto-approved)" className="iu-btn-secondary !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200">
              <Coffee size={16}/> Apply break
            </button>
            <button data-testid="apply-on-behalf" onClick={() => setShowOnBehalf(true)} title="File a leave, tour or late arrival for a member who can't do it themselves" className="iu-btn-primary">
              <Plus size={16}/> Apply on behalf
            </button>
          </div>
        </header>
      )}

      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <div className="flex gap-2 overflow-x-auto pb-3 flex-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              data-testid={`leaves-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
              className={`iu-chip whitespace-nowrap shrink-0 ${filter === f.key ? "iu-chip-active" : ""}`}
            >{f.label}</button>
          ))}
        </div>
        {embedded && (
          <div className="flex gap-2 shrink-0">
            <button data-testid="apply-break" onClick={openBreakModal} title="Log a short mid-day break for a member (auto-approved)" className="iu-btn-secondary !h-9 !px-3 !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200">
              <Coffee size={14}/> Apply break
            </button>
            <button data-testid="apply-on-behalf" onClick={() => setShowOnBehalf(true)} title="File a leave, tour or late arrival for a member who can't do it themselves" className="iu-btn-primary !h-9 !px-3">
              <Plus size={14}/> Apply on behalf
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <>
          {/* --- PENDING approvals grid --- */}
          {pendingRows.length === 0 ? (
            <div className="iu-card p-8 text-center text-slate-500" data-testid="admin-leaves-empty-pending">
              No pending requests.
            </div>
          ) : (
        <div
          data-testid="admin-leaves-list"
          className="iu-card !p-0 overflow-auto rounded-lg"
          // Cap the height so the table itself scrolls (with the header
          // staying stuck at the top via `sticky top-0`). The cap subtracts
          // the page-header + filter chip row + outer padding so the
          // bottom edge sits roughly at the viewport baseline.
          style={{ maxHeight: "calc(100vh - 220px)" }}
        >
          <table className="w-full text-sm min-w-[1080px] border-separate border-spacing-0">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226,232,240)]">
                <th className="iu-table-th !text-left bg-slate-50 w-8"></th>
                <th className="iu-table-th !text-left bg-slate-50">Member</th>
                <th className="iu-table-th !text-left bg-slate-50">Type</th>
                <th className="iu-table-th !text-left bg-slate-50">From → To</th>
                <th className="iu-table-th !text-right w-16 bg-slate-50">Days</th>
                <th className="iu-table-th !text-left w-28 bg-slate-50">Applied</th>
                <th className="iu-table-th !text-left bg-slate-50">Reason</th>
                <th className="iu-table-th !text-left w-24 bg-slate-50">Status</th>
                <th className="iu-table-th !text-left bg-slate-50">Decided by</th>
                <th className="iu-table-th !text-right w-44 bg-slate-50">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pendingRows.map((l) => {
                const typeMeta = TYPE_META[l.type] || { label: l.type, cls: "bg-slate-100 text-slate-700" };
                const statusMeta = STATUS_META[l.status] || { label: l.status, cls: "bg-slate-100 text-slate-700" };
                const days = l.half_day ? 0.5 : daysInclusive(l.start_date, l.end_date);
                const isExpanded = expandedId === l.id;
                const showExpander = l.type === "leave" || l.type === "tour" || l.type === "comp_off" || l.type === "posting";
                return (
                  <React.Fragment key={l.id}>
                  <tr
                    data-testid={`leave-row-${l.id}`}
                    className={`border-t border-slate-100 hover:bg-sky-50/40 ${l.late_application ? "bg-red-50/40" : ""}`}
                  >
                    <td className="iu-table-td">
                      {showExpander && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(l)}
                          data-testid={`expand-${l.id}`}
                          aria-expanded={isExpanded}
                          title={isExpanded ? "Hide details" : "Show overlap & balance"}
                          className="p-1 rounded hover:bg-slate-200 text-slate-500"
                        >
                          {isExpanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
                        </button>
                      )}
                    </td>
                    <td className="iu-table-td">
                      <div className="font-semibold text-slate-800">{l.member_name}</div>
                      <div className="text-xs text-slate-500">{l.member_rank ? `${l.member_rank} · ` : ""}{l.member_category}</div>
                      {l.status === "pending" && (
                        <BalanceChip
                          data={balanceMap[l.user_id]}
                          requestedDays={days}
                          leaveType={l.type}
                          testid={`balance-chip-${l.id}`}
                        />
                      )}
                    </td>
                    <td className="iu-table-td">
                      <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold uppercase ${typeMeta.cls}`}>
                        {typeMeta.label}
                      </span>
                      {l.half_day && (
                        <div
                          className="mt-1 inline-flex items-center px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[9px] font-extrabold uppercase tracking-wide"
                          data-testid={`halfday-chip-${l.id}`}
                          title={`Half-day (${l.half_day === "FN" ? "forenoon" : "postnoon"})`}
                        >
                          Half · {l.half_day}
                        </div>
                      )}
                      {l.late_application && (
                        <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[9px] font-extrabold uppercase tracking-wide" data-testid={`late-chip-${l.id}`}>
                          <AlertTriangle size={9} /> Late
                        </div>
                      )}
                    </td>
                    <td className="iu-table-td whitespace-nowrap text-slate-700">
                      <div className="font-mono text-xs">{shortDate(l.start_date)} → {shortDate(l.end_date)}</div>
                      {l.location && <div className="text-[11px] text-slate-500">{l.location}</div>}
                    </td>
                    <td className="iu-table-td text-right font-mono font-semibold">{days}</td>
                    <td className="iu-table-td text-xs text-slate-600 whitespace-nowrap">{shortDate(l.created_at)}</td>
                    <td className="iu-table-td text-slate-700 text-xs max-w-[260px]">
                      <div className="line-clamp-2" title={l.reason}>{l.reason || <span className="text-slate-300">—</span>}</div>
                    </td>
                    <td className="iu-table-td">
                      <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${statusMeta.cls}`} data-testid={`status-pill-${l.id}`}>
                        {statusMeta.label}
                      </span>
                    </td>
                    <td className="iu-table-td text-xs">
                      {l.decided_by ? (
                        <div data-testid={`decided-by-${l.id}`}>
                          <div className="font-semibold text-slate-700">{l.decided_by}</div>
                          {l.decided_at && <div className="text-[10px] text-slate-500">{shortDate(l.decided_at)}</div>}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="iu-table-td">
                      <div className="flex items-center gap-1.5 justify-end flex-nowrap">
                        {l.status === "pending" ? (
                          <>
                            <button
                              data-testid={`approve-${l.id}`}
                              onClick={() => startApprove(l)}
                              disabled={confirmBusy && confirmGate?.leave?.id !== l.id}
                              className="iu-btn-primary !h-8 !px-2.5 !text-xs"
                            >
                              <Check size={12}/> Approve
                            </button>
                            <button data-testid={`reject-${l.id}`} onClick={() => startReject(l)} title="Turn down this request — the member is notified" className="iu-btn-secondary !h-8 !px-2.5 !text-xs"><X size={12}/> Reject</button>
                          </>
                        ) : (
                          <button
                            data-testid={`reopen-${l.id}`}
                            onClick={() => decide(l.id, "pending")}
                            className="text-[11px] text-slate-500 hover:text-slate-800 hover:underline"
                            title="Re-open: move back to Pending for re-decision"
                          >
                            Re-open
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {/* Detail row: overlap + applicant's live balances. Renders
                      only when the chevron is open and limited to applicable
                      multi-day types (leave / tour / legacy comp-off). */}
                  {isExpanded && showExpander && (
                    <tr data-testid={`detail-row-${l.id}`} className="border-t border-slate-100">
                      <td colSpan={10} className="bg-slate-50/70 px-4 py-3">
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          <OverlapNotice
                            startDate={l.start_date}
                            endDate={l.end_date}
                            excludeUserId={l.user_id}
                            excludeLeaveId={l.id}
                            title="Others on leave / tour during this period"
                            defaultOpen
                          />
                          <BalanceSummaryCard
                            data={balanceMap[l.user_id]}
                            memberName={l.member_name}
                            requestedDays={days}
                            leaveType={l.type}
                          />
                        </div>
                        {/* Camp/Regatta conflict — spans full width on the
                            next line so the chip text stays readable. */}
                        <div className="mt-3">
                          <EventConflictNotice
                            startDate={l.start_date}
                            endDate={l.end_date}
                            userId={l.user_id}
                            defaultOpen
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
          )}

          {/* --- DECISION HISTORY grid — newest at top --- */}
          <DecisionHistory
            rows={decidedRows}
            onReopen={(id) => decide(id, "pending")}
          />
        </>
      )}

      {rejectTarget && (
        <RejectReasonModal
          leave={rejectTarget}
          reason={rejectReason}
          onReasonChange={setRejectReason}
          busy={rejectBusy}
          onCancel={() => { setRejectTarget(null); setRejectReason(""); }}
          onSubmit={submitReject}
        />
      )}

      {showOnBehalf && (
        <ApplyForm
          asAdmin
          onClose={() => setShowOnBehalf(false)}
          onCreated={() => { setShowOnBehalf(false); load(); }}
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
      {confirmGate && (
        <ConflictAcknowledgeModal
          open
          camps={confirmGate.camps}
          regattas={confirmGate.regattas}
          heading="Confirm approval — conflicts detected"
          subheading={
            <>
              <span className="font-semibold">{confirmGate.leave.member_name}</span>&apos;s{" "}
              {confirmGate.leave.type === "posting" ? "posting" : confirmGate.leave.type} runs{" "}
              <span className="font-mono">
                {shortDate(confirmGate.leave.start_date)} → {shortDate(confirmGate.leave.end_date)}
              </span>
              , overlapping{" "}
              <span className="font-bold">{confirmGate.camps.length + confirmGate.regattas.length}</span>{" "}
              scheduled event{(confirmGate.camps.length + confirmGate.regattas.length) === 1 ? "" : "s"}.
            </>
          }
          ackLabel="I've reviewed the conflicts above and confirm this member can be spared during these events."
          confirmLabel="Confirm approval"
          testIdPrefix="approve-conflict-gate"
          onCancel={() => setConfirmGate(null)}
          onConfirm={async () => {
            await decide(confirmGate.leave.id, "approved");
            setConfirmGate(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * BalanceSummaryCard — small inline card shown in the Approvals detail row
 * so admins see the applicant's live Comp-Off and Paid-Leave pools at the
 * point of decision. The numbers come from `/api/members/{id}/leave-summary`
 * (the same unified summary the apply form uses), so this stays in sync
 * with the waterfall deduction logic in `holidays.split_leave_days`.
 */
function BalanceSummaryCard({ data, memberName, requestedDays, leaveType }) {
  if (!data) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500 flex items-center gap-2" data-testid="balance-loading">
        <Loader2 size={12} className="animate-spin"/> Loading {memberName}&apos;s balance…
      </div>
    );
  }
  if (data.error) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500" data-testid="balance-error">
        Couldn&apos;t load balance for {memberName}.
      </div>
    );
  }
  const co = data.comp_off || { accrued: 0, used: 0, available: 0 };
  const pl = data.paid_leave || { opening: null, used: 0, available: 0, tracked: false };
  // Mirror backend `split_leave_days` so the admin sees the same ladder
  // the apply form previewed for the applicant.
  const coUsed = Math.min(requestedDays, Math.max(0, co.available));
  const plUsed = Math.min(requestedDays - coUsed, Math.max(0, pl.available));
  const lop = Math.max(0, requestedDays - coUsed - plUsed);
  const showLadder = leaveType === "leave";
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5" data-testid="balance-card">
      <div className="flex items-center gap-2 mb-2">
        <Users size={12} className="text-slate-500"/>
        <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">{memberName}&apos;s balance</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-md bg-violet-50/70 border border-violet-100 px-2 py-1.5" data-testid="balance-comp-off">
          <div className="text-[10px] uppercase tracking-wide font-bold text-violet-700 inline-flex items-center gap-1">
            <RefreshCw size={9}/> Comp-Off available
          </div>
          <div className="font-extrabold text-base leading-tight text-violet-800">{co.available}</div>
          <div className="text-[10px] text-violet-700/70">accrued {co.accrued} − used {co.used}</div>
        </div>
        <div className="rounded-md bg-amber-50/70 border border-amber-100 px-2 py-1.5" data-testid="balance-paid-leave">
          <div className="text-[10px] uppercase tracking-wide font-bold text-amber-700 inline-flex items-center gap-1">
            <Bed size={9}/> Paid Leave available
          </div>
          <div className="font-extrabold text-base leading-tight text-amber-800">
            {pl.tracked ? round1(pl.available) : "—"}
          </div>
          <div className="text-[10px] text-amber-700/70">
            {pl.tracked
              ? `opening ${round1(pl.opening) || 0} − used ${round1(pl.used) || 0}`
              : "no opening balance"}
            {pl.tracked && (pl.half_count || 0) > 0 && (
              <span className="ml-1" data-testid="balance-half-breakdown">
                · {pl.full_count || 0} full + {pl.half_count} half
              </span>
            )}
          </div>
        </div>
      </div>
      {showLadder && (
        <div className="mt-2 text-[11px] text-slate-700" data-testid="balance-ladder">
          Approving will draw <strong>{coUsed}</strong> from Comp-Off + <strong>{round1(plUsed)}</strong> from Paid Leave
          {lop > 0 && <> + <strong className="text-red-700 uppercase">{lop} LOP</strong></>}.
        </div>
      )}
      {leaveType === "tour" && (
        <div className="mt-2 text-[11px] text-slate-500" data-testid="balance-tour-note">
          Tours don&apos;t consume Comp-Off or Paid Leave.
        </div>
      )}
      {leaveType === "posting" && (
        <div className="mt-2 text-[11px] text-sky-700" data-testid="balance-posting-note">
          Postings don&apos;t consume Comp-Off or Paid Leave, and weekly-off attendance during a posting won&apos;t accrue Comp-Off either.
        </div>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  BalanceChip — inline "X days available" pill on the pending row.  */
/*  Colour flips to rose when the requested days would exceed the      */
/*  applicant's available paid-leave + comp-off pool. Lets an admin    */
/*  spot LOP-triggering approvals at a glance without expanding.       */
/* ------------------------------------------------------------------ */
function BalanceChip({ data, requestedDays, leaveType, testid }) {
  if (leaveType !== "leave") return null;  // Tours / postings don't consume.
  if (!data) {
    return (
      <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-400" data-testid={testid}>
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
      className={`mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${
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

/* ------------------------------------------------------------------ */
/*  RejectReasonModal — mandatory denial reason. Sent as body.        */
/*  denial_reason on the PATCH so the applicant sees "why" when they   */
/*  check their own list.                                              */
/* ------------------------------------------------------------------ */
function RejectReasonModal({ leave, reason, onReasonChange, busy, onCancel, onSubmit }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" data-testid="reject-modal">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-extrabold text-slate-900">Reject request</h3>
          <p className="text-xs text-slate-500 mt-1">
            {leave.member_name}&apos;s {leave.type} · {shortDate(leave.start_date)} → {shortDate(leave.end_date)}
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          <label className="text-xs font-bold text-slate-600 uppercase tracking-wider" htmlFor="reject-reason">
            Reason for rejection *
          </label>
          <textarea
            id="reject-reason"
            data-testid="reject-reason-input"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            rows={3}
            autoFocus
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
            placeholder="e.g. Camp starts on 12 Aug and you are on the coach roster"
          />
          <p className="text-[11px] text-slate-500">The applicant will see this on their own leave list — please be specific.</p>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button type="button" data-testid="reject-modal-cancel" onClick={onCancel} disabled={busy} className="iu-btn-secondary !h-9 !px-3 !text-sm">Cancel</button>
          <button type="button" data-testid="reject-modal-confirm" onClick={onSubmit} disabled={busy || !reason.trim()} className="iu-btn-primary !h-9 !px-3 !text-sm !bg-rose-600 hover:!bg-rose-700">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            Reject request
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  DecisionHistory — audit-trail table shown below the pending grid   */
/*  after every decision. Reverse chronological (latest at top).       */
/*  Carries all pending columns PLUS: turnaround (applied → decided),  */
/*  denial reason, balance-at-decision snapshot, YTD applied / denied. */
/* ------------------------------------------------------------------ */
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

function DecisionHistory({ rows, onReopen }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">No approved or rejected requests yet.</div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history">
      <div className="flex items-center gap-2 mb-2 text-slate-500">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top — {rows.length} decision{rows.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="iu-card !p-0 overflow-auto rounded-lg" style={{ maxHeight: "calc(100vh - 260px)" }}>
        <table className="w-full text-sm min-w-[1400px] border-separate border-spacing-0">
          <thead>
            <tr className="bg-slate-50 text-slate-500 text-xs sticky top-0 z-10 shadow-[0_1px_0_0_rgb(226,232,240)]">
              <th className="iu-table-th !text-left bg-slate-50">Member</th>
              <th className="iu-table-th !text-left bg-slate-50">Type</th>
              <th className="iu-table-th !text-left bg-slate-50">From → To</th>
              <th className="iu-table-th !text-right w-14 bg-slate-50">Days</th>
              <th className="iu-table-th !text-left w-24 bg-slate-50">Applied on</th>
              <th className="iu-table-th !text-left bg-slate-50">Reason for applying</th>
              <th className="iu-table-th !text-left w-24 bg-slate-50">Status</th>
              <th className="iu-table-th !text-left bg-slate-50">Decided by</th>
              <th className="iu-table-th !text-left w-24 bg-slate-50">Decided on</th>
              <th className="iu-table-th !text-left w-20 bg-slate-50" title="Time between application and decision">Turnaround</th>
              <th className="iu-table-th !text-left bg-slate-50">Denial reason</th>
              <th className="iu-table-th !text-right w-24 bg-slate-50" title="Applicant's paid-leave + comp-off pool at decision time">Balance @ decision</th>
              <th className="iu-table-th !text-right w-20 bg-slate-50" title="Total days applied this cycle">Applied (YTD)</th>
              <th className="iu-table-th !text-right w-20 bg-slate-50" title="Total days denied this cycle">Denied (YTD)</th>
              <th className="iu-table-th !text-right w-20 bg-slate-50">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const tm = TYPE_META[l.type] || { label: l.type, cls: "bg-slate-100 text-slate-700" };
              const sm = STATUS_META[l.status] || { label: l.status, cls: "bg-slate-100 text-slate-700" };
              const days = l.half_day ? 0.5 : daysInclusive(l.start_date, l.end_date);
              const bal = l.balance_at_decision;
              const balTotal = bal
                ? round1((bal.paid_leave_available || 0) + (bal.comp_off_available || 0))
                : null;
              return (
                <tr key={l.id} data-testid={`history-row-${l.id}`} className="border-t border-slate-100 hover:bg-sky-50/40">
                  <td className="iu-table-td">
                    <div className="font-semibold text-slate-800">{l.member_name}</div>
                    <div className="text-xs text-slate-500">{l.member_rank ? `${l.member_rank} · ` : ""}{l.member_category}</div>
                  </td>
                  <td className="iu-table-td">
                    <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold uppercase ${tm.cls}`}>{tm.label}</span>
                    {l.half_day && (
                      <div className="mt-1 inline-flex items-center px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[9px] font-extrabold uppercase tracking-wide">
                        Half · {l.half_day}
                      </div>
                    )}
                  </td>
                  <td className="iu-table-td whitespace-nowrap text-slate-700">
                    <div className="font-mono text-xs">{shortDate(l.start_date)} → {shortDate(l.end_date)}</div>
                    {l.location && <div className="text-[11px] text-slate-500">{l.location}</div>}
                  </td>
                  <td className="iu-table-td text-right font-mono font-semibold">{days}</td>
                  <td className="iu-table-td text-xs text-slate-600 whitespace-nowrap">{shortDate(l.created_at)}</td>
                  <td className="iu-table-td text-slate-700 text-xs max-w-[220px]">
                    <div className="line-clamp-2" title={l.reason}>{l.reason || <span className="text-slate-300">—</span>}</div>
                  </td>
                  <td className="iu-table-td">
                    <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${sm.cls}`}>
                      {sm.label}
                    </span>
                  </td>
                  <td className="iu-table-td text-xs font-semibold text-slate-700">{l.decided_by || <span className="text-slate-300">—</span>}</td>
                  <td className="iu-table-td text-xs text-slate-600 whitespace-nowrap">
                    {l.decided_at ? shortDate(l.decided_at) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="iu-table-td text-[11px] font-mono text-slate-600">{fmtTurnaround(l.created_at, l.decided_at)}</td>
                  <td className="iu-table-td text-xs text-slate-700 max-w-[240px]">
                    {l.status === "rejected"
                      ? (l.denial_reason
                          ? <div className="line-clamp-2 text-rose-700" title={l.denial_reason}>{l.denial_reason}</div>
                          : <span className="text-slate-300">—</span>)
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="iu-table-td text-right text-xs font-mono">
                    {balTotal != null ? (
                      <span title={`${bal.comp_off_available ?? 0} comp-off + ${bal.paid_leave_available ?? 0} paid leave`}>
                        {balTotal}
                      </span>
                    ) : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="iu-table-td text-right text-xs font-mono">
                    {typeof l.ytd_applied_days === "number" ? l.ytd_applied_days : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="iu-table-td text-right text-xs font-mono">
                    {typeof l.ytd_denied_days === "number" ? l.ytd_denied_days : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="iu-table-td text-right">
                    <button
                      data-testid={`history-reopen-${l.id}`}
                      onClick={() => onReopen(l.id)}
                      title="Move this decided request back to pending for a fresh decision"
                      className="text-[11px] text-slate-500 hover:text-slate-800 hover:underline"
                    >
                      Re-open
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
