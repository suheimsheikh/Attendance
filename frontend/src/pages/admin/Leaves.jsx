import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Check, X, AlertTriangle, Plus, Coffee } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { shortDate } from "../../utils";
import { ApplyForm } from "../MyLeaves";
import { BreakForm } from "./Calendar";

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

  const decide = async (id, status) => {
    try {
      await api.patch(`/leaves/${id}`, { status });
      toast.success(`Request ${status}`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
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
                const days = daysInclusive(l.start_date, l.end_date);
                return (
                  <tr
                    key={l.id}
                    data-testid={`leave-row-${l.id}`}
                    className={`border-t border-slate-100 hover:bg-sky-50/40 ${l.late_application ? "bg-red-50/40" : ""}`}
                  >
                    <td className="iu-table-td">
                      <div className="font-semibold text-slate-800">{l.member_name}</div>
                      <div className="text-xs text-slate-500">{l.member_rank ? `${l.member_rank} · ` : ""}{l.member_category}</div>
                    </td>
                    <td className="iu-table-td">
                      <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold uppercase ${typeMeta.cls}`}>
                        {typeMeta.label}
                      </span>
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
                            <button data-testid={`approve-${l.id}`} onClick={() => decide(l.id, "approved")} className="iu-btn-primary !h-8 !px-2.5 !text-xs"><Check size={12}/> Approve</button>
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
    </div>
  );
}
