import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, AlertTriangle, Plus, Coffee, ChevronDown, ChevronUp, Users, RefreshCw, Bed, Tent, Sailboat, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { shortDate } from "../../utils";
import { ApplyForm } from "../MyLeaves";
import { BreakForm } from "./Calendar";
import OverlapNotice from "../../components/OverlapNotice";
import EventConflictNotice from "../../components/EventConflictNotice";

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

  const decide = async (id, status) => {
    try {
      await api.patch(`/leaves/${id}`, { status });
      toast.success(`Request ${status}`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
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
            <button data-testid="apply-break" onClick={openBreakModal} className="iu-btn-secondary !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200">
              <Coffee size={16}/> Apply break
            </button>
            <button data-testid="apply-on-behalf" onClick={() => setShowOnBehalf(true)} className="iu-btn-primary">
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
            <button data-testid="apply-break" onClick={openBreakModal} className="iu-btn-secondary !h-9 !px-3 !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200">
              <Coffee size={14}/> Apply break
            </button>
            <button data-testid="apply-on-behalf" onClick={() => setShowOnBehalf(true)} className="iu-btn-primary !h-9 !px-3">
              <Plus size={14}/> Apply on behalf
            </button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : visible.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500">No {filter === "all" ? "" : filter} requests.</div>
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
              {visible.map((l) => {
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
                            <button data-testid={`reject-${l.id}`} onClick={() => decide(l.id, "rejected")} className="iu-btn-secondary !h-8 !px-2.5 !text-xs"><X size={12}/> Reject</button>
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
        <ApproveConflictGate
          gate={confirmGate}
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
 * ApproveConflictGate — modal blocker shown when the admin clicks
 * Approve on a Leave/Tour/Posting that overlaps one or more camps or
 * regattas. Requires the admin to explicitly tick "I've reviewed the
 * conflicts" before the Confirm button unlocks — a small friction to
 * make sure the notice isn't just clicked-through on autopilot.
 *
 * The API lookup runs in the parent (so we can skip the modal entirely
 * when the leave has zero conflicts); this component is purely UI.
 */
function ApproveConflictGate({ gate, onCancel, onConfirm }) {
  const { leave, camps, regattas } = gate;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const total = camps.length + regattas.length;
  const submit = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };
  return (
    <div
      className="iu-modal"
      data-testid="approve-conflict-gate"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="iu-modal-card max-w-lg">
        <header className="p-4 border-b border-amber-100 bg-amber-50/60 rounded-t-lg flex items-start gap-3">
          <ShieldAlert size={22} className="text-amber-700 shrink-0 mt-0.5"/>
          <div className="flex-1">
            <h3 className="font-extrabold text-slate-900 text-sm">Confirm approval — conflicts detected</h3>
            <p className="text-xs text-slate-600 mt-0.5">
              <span className="font-semibold">{leave.member_name}</span>&apos;s{" "}
              {leave.type === "posting" ? "posting" : leave.type} runs{" "}
              <span className="font-mono">{shortDate(leave.start_date)} → {shortDate(leave.end_date)}</span>,
              overlapping <span className="font-bold">{total}</span> scheduled event{total === 1 ? "" : "s"}.
            </p>
          </div>
        </header>

        <div className="p-4 space-y-3 max-h-[50vh] overflow-y-auto">
          {camps.length > 0 && (
            <div data-testid="gate-camps">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5 inline-flex items-center gap-1">
                <Tent size={11}/> Camps ({camps.length})
              </div>
              <ul className="space-y-1">
                {camps.map((c) => (
                  <li key={c.id} className="text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-baseline gap-2" data-testid={`gate-camp-${c.id}`}>
                    <span className="font-semibold text-amber-900 flex-1">{c.name}</span>
                    <span className="font-mono text-[10px] text-amber-800 shrink-0">
                      {shortDate(c.start_date)}
                      {c.start_date !== c.end_date && ` → ${shortDate(c.end_date)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {regattas.length > 0 && (
            <div data-testid="gate-regattas">
              <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5 inline-flex items-center gap-1">
                <Sailboat size={11}/> Regattas ({regattas.length})
              </div>
              <ul className="space-y-1">
                {regattas.map((r) => (
                  <li key={r.id} className="text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-baseline gap-2" data-testid={`gate-regatta-${r.id}`}>
                    <span className="font-semibold text-amber-900 flex-1">
                      {r.name}
                      {r.location && <span className="text-amber-700/70 font-normal"> · {r.location}</span>}
                    </span>
                    <span className="font-mono text-[10px] text-amber-800 shrink-0">
                      {shortDate(r.start_date)}
                      {r.start_date !== r.end_date && ` → ${shortDate(r.end_date)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="px-4 pb-4">
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid="gate-ack-checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
            />
            <span>
              I&apos;ve reviewed the conflicts above and confirm this member can be spared during these events.
            </span>
          </label>
        </div>

        <div className="p-3 border-t border-slate-100 flex gap-2 bg-slate-50/40 rounded-b-lg">
          <button
            type="button"
            onClick={onCancel}
            className="iu-btn-secondary flex-1"
            data-testid="gate-cancel"
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!ack || busy}
            data-testid="gate-confirm"
            className="iu-btn-primary flex-1"
          >
            {busy ? <Loader2 className="animate-spin" size={14}/> : <Check size={14}/>}
            Confirm approval
          </button>
        </div>
      </div>
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

function round1(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 10) / 10;
}
