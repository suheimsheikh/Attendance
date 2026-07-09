/**
 * MonthCorrectionsCard — Dashboard side-rail widget listing every
 * correction filed this calendar month. Scrollable box (up to
 * ~24rem) with per-row "Undo" for admin-filed (auto-approved) rows.
 *
 * Powers itself off `GET /api/admin/corrections/month?month=YYYY-MM`
 * and calls `POST /api/admin/corrections/{cid}/undo` when the admin
 * clicks Undo — refetches on success so the row shows as "Undone".
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Undo2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";

const KIND_LABEL = {
  missed_checkin:    "Missed check-in",
  time_adjust:       "Time adjust",
  leave_cancel:      "Leave cancel",
  leave_date_change: "Leave dates",
  leave_type_change: "Leave type",
};

const STATUS_STYLE = {
  approved:  "bg-emerald-100 text-emerald-700",
  pending:   "bg-amber-100 text-amber-700",
  rejected:  "bg-rose-100 text-rose-700",
  cancelled: "bg-slate-200 text-slate-600",
};

function currentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

export default function MonthCorrectionsCard() {
  const [monthIso, setMonthIso] = useState(currentMonthIso());
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.get("/admin/corrections/month", { month: monthIso });
      setRows(d.rows || []);
    } catch (err) {
      toast.error(err?.message || "Failed to load corrections");
    } finally { setLoading(false); }
  }, [monthIso]);

  useEffect(() => { load(); }, [load]);

  const undo = async (row) => {
    if (row.undone) return;
    if (!window.confirm(
      `Undo the ${KIND_LABEL[row.kind] || row.kind} correction for ${row.requester_name} on ${fmtDate(row.target_date)}?`
    )) return;
    setBusyId(row.id);
    try {
      await api.post(`/admin/corrections/${row.id}/undo`);
      toast.success("Correction undone");
      await load();
    } catch (err) {
      toast.error(err?.message || "Undo failed");
    } finally { setBusyId(null); }
  };

  const counts = useMemo(() => ({
    total:    rows.length,
    active:   rows.filter((r) => r.status === "approved" && !r.undone).length,
    undone:   rows.filter((r) => r.undone).length,
    pending:  rows.filter((r) => r.status === "pending").length,
  }), [rows]);

  return (
    <section
      className="iu-card p-4 flex flex-col gap-3"
      data-testid="dashboard-month-corrections"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-800 text-sm">Corrections this month</h3>
        <input
          type="month"
          value={monthIso}
          onChange={(e) => setMonthIso(e.target.value)}
          className="iu-input !py-1 !h-7 !text-[11px] !w-auto"
          data-testid="corrections-month-input"
        />
      </header>

      <div className="flex flex-wrap gap-1.5 text-[10px]" data-testid="corrections-counts">
        <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold">Total {counts.total}</span>
        <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">Active {counts.active}</span>
        {counts.pending > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">Pending {counts.pending}</span>
        )}
        {counts.undone > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-500 font-semibold">Undone {counts.undone}</span>
        )}
      </div>

      <div
        className="border border-slate-100 rounded-lg overflow-y-auto"
        style={{ maxHeight: "24rem" }}
        data-testid="corrections-scrollbox"
      >
        {loading && (
          <div className="p-4 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        )}
        {!loading && rows.length === 0 && (
          <div className="p-6 text-center text-xs text-slate-400" data-testid="corrections-empty">
            No corrections filed this month.
          </div>
        )}
        {!loading && rows.length > 0 && (
          <ul className="divide-y divide-slate-100">
            {rows.map((r) => {
              const status = r.undone ? "undone" : r.status;
              const canUndo = r.status === "approved" && !r.undone;
              return (
                <li
                  key={r.id}
                  className={`px-2.5 py-2 flex items-start gap-2 text-[11px] ${r.undone ? "opacity-60" : ""}`}
                  data-testid={`correction-row-${r.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-slate-800 truncate max-w-[140px]" title={r.requester_name}>
                        {r.requester_name}
                      </span>
                      <span className={`px-1.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                        r.undone ? "bg-slate-200 text-slate-500" : (STATUS_STYLE[r.status] || "bg-slate-100 text-slate-600")
                      }`}>
                        {status}
                      </span>
                    </div>
                    <div className="text-slate-600 leading-tight">
                      {KIND_LABEL[r.kind] || r.kind} &middot; <span className="font-mono">{fmtDate(r.target_date)}</span>
                    </div>
                    {r.filed_by_admin_name && (
                      <div className="text-[10px] text-slate-400 leading-tight">
                        by {r.filed_by_admin_name}
                        {r.undone_by_name && ` &rarr; undone by ${r.undone_by_name}`}
                      </div>
                    )}
                    {r.reason && (
                      <div className="text-[10px] text-slate-500 italic truncate" title={r.reason}>
                        &ldquo;{r.reason}&rdquo;
                      </div>
                    )}
                  </div>
                  {canUndo && (
                    <button
                      onClick={() => undo(r)}
                      disabled={busyId === r.id}
                      className="shrink-0 p-1.5 rounded-md hover:bg-rose-50 text-rose-600 disabled:opacity-40"
                      title="Undo this correction"
                      data-testid={`correction-undo-${r.id}`}
                    >
                      {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Link
        to="/admin/corrections"
        className="inline-flex items-center gap-1 text-xs text-sky-600 hover:text-sky-700 font-semibold self-start"
        data-testid="corrections-view-all"
      >
        Full corrections queue <ExternalLink size={12} />
      </Link>
    </section>
  );
}
