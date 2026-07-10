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
import { Loader2, RefreshCw, Check, X, Plane, LogIn, PencilRuler } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { formatDate, formatTime } from "../../utils";
import { showApiError } from "../../api";

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
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("all");
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // allSettled — a single failing queue must NOT blank out the whole
      // Approvals page. A legacy /leaves 500 was previously making the
      // sidebar badge (which counts records directly) diverge from the
      // (empty) table for admins — see prod bug 20 Feb 2026.
      const [leavesRes, checkinsRes, correctionsRes] = await Promise.allSettled([
        api.get("/leaves"),
        api.get("/admin/checkin-approvals", { status: "pending" }),
        api.get("/admin/corrections", { status: "pending" }),
      ]);
      const asArray = (r) => Array.isArray(r) ? r : (r?.items || r?.rows || []);
      const settled = (res, label) => {
        if (res.status === "fulfilled") return asArray(res.value);
        // eslint-disable-next-line no-console
        console.warn(`[approvals] ${label} endpoint failed`, res.reason);
        toast.error(`Couldn't load ${label} — showing the rest`);
        return [];
      };
      const safeMap = (arr, fn, label) => {
        const out = [];
        for (const [i, row] of arr.entries()) {
          try { out.push(fn(row)); } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`[approvals] ${label}[${i}] threw`, e, row);
          }
        }
        return out;
      };
      const leavesArr = safeMap(settled(leavesRes, "leaves").filter((l) => l.status === "pending"), normLeave, "leave");
      const ckArr = safeMap(settled(checkinsRes, "check-ins"), normCheckin, "checkin");
      const corArr = safeMap(settled(correctionsRes, "corrections"), normCorrection, "correction");
      const merged = [...leavesArr, ...ckArr, ...corArr];
      // Latest first.
      merged.sort((a, b) => (b.submitted_at || "").localeCompare(a.submitted_at || ""));
      setRows(merged);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

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
      // Optimistic: pull the row out immediately so admins don't
      // wait on a refetch to see it disappear.
      setRows((prev) => prev.filter((r) => !(r.kind === row.kind && r.id === row.id)));
    } catch (err) {
      showApiError(err, `Could not ${decision}`);
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
        <button
          onClick={load}
          className="iu-btn-secondary"
          disabled={loading}
          data-testid="approvals-refresh"
        >
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Refresh
        </button>
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
              {loading && (
                <tr><td colSpan={6} className="py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && filteredRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-400" data-testid="approvals-empty">
                    Nothing pending in this filter. 🎉
                  </td>
                </tr>
              )}
              {!loading && filteredRows.map((r) => {
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
    </div>
  );
}
