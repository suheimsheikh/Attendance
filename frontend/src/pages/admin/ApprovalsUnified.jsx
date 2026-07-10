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
import { Loader2, RefreshCw, Check, X, Plane, LogIn, PencilRuler, Plus, Coffee } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { formatDate, formatTime } from "../../utils";
import { ApplyForm } from "../MyLeaves";
import { BreakForm } from "./Calendar";

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
    when: `${formatDate(row.start_date)}${row.end_date && row.end_date !== row.start_date ? ` → ${formatDate(row.end_date)}` : ""}`,
    details: [
      (row.type || "leave").toUpperCase(),
      days ? `${days}d` : null,
      row.reason,
    ].filter(Boolean).join(" · "),
    apply: async (decision) => {
      await api.patch(`/leaves/${row.id}`, { status: decision === "approve" ? "approved" : "rejected" });
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
    when: `${formatDate(row.date)} · ${formatTime(row.check_in_at)}`,
    details: [
      row.method ? row.method.toUpperCase() : null,
      row.geofence_status || (row.distance_m ? `${Math.round(row.distance_m)}m from site` : null),
      row.reason,
    ].filter(Boolean).join(" · "),
    apply: async (decision) => {
      await api.post(`/admin/checkin-approvals/${row.id}/decide`, {
        decision: decision === "approve" ? "approved" : "rejected",
        note: "",
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
    when: formatDate(row.target_date),
    details: [
      (row.kind || "").replace(/_/g, " "),
      row.filed_by_admin_name ? `filed by ${row.filed_by_admin_name}` : null,
      row.reason,
    ].filter(Boolean).join(" · "),
    apply: async (decision) => {
      await api.post(`/admin/corrections/${row.id}/decide`, {
        status: decision === "approve" ? "approved" : "rejected",
      });
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
    ],
  });
  const [leavesQ, checkinsQ, correctionsQ] = queries;
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
    setBusyId(`${row.kind}-${row.id}-${decision}`);
    try {
      await row.apply(decision);
      toast.success(`${decision === "approve" ? "Approved" : "Rejected"}: ${row.member_name}`);
      // Optimistic: yank the row out of its per-queue cache so admins
      // don't wait on the refetch to see it disappear. Then trigger a
      // background refetch for authoritative state + summary sync.
      const dropRow = (arr) => {
        if (!Array.isArray(arr)) return arr;
        return arr.filter((x) => (x.id ?? x._id) !== row.id);
      };
      if (row.kind === "leave") {
        queryClient.setQueryData(["/leaves", null], dropRow);
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
            className="iu-btn-secondary !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200"
            data-testid="apply-break"
          >
            <Coffee size={14}/> Apply break
          </button>
          <button
            onClick={() => setShowOnBehalf(true)}
            className="iu-btn-primary"
            data-testid="apply-on-behalf"
          >
            <Plus size={14}/> Apply on behalf
          </button>
          <button
            onClick={load}
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
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="approvals-table">
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
                return (
                  <tr key={`${r.kind}-${r.id}`} className="border-b border-slate-100 hover:bg-slate-50 transition-colors" data-testid={`approvals-row-${r.kind}-${r.id}`}>
                    <td className="py-2 px-3 font-semibold text-slate-800">{r.member_name}</td>
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
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

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
    </div>
  );
}
