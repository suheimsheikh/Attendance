import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../api";
import { categoryLabel } from "../../utils";

/**
 * Composite Ledger tab — one row per member with figures pulled
 * straight from each per-member ledger (Attendance / OT / Comp-off /
 * Leave), scoped to a calendar month.
 *
 * Filter pills mirror the Attendance tab (category / fleet / institution).
 * Comp-off column is EARNED only, per user requirement.
 */

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "elite",   label: "Elite" },
  { key: "rest",    label: "Staff & Coaches" },
];

function fmtHM(min) {
  if (!min) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function CompositeLedgerTab({ monthIso, monthLabel, isCurrent, onPrevMonth, onNextMonth, onJumpToday, MonthNav, athleteLikeKeys }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");

  const isAthleteLike = useCallback(
    (r) => athleteLikeKeys.has(r?.category),
    [athleteLikeKeys]
  );

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/reports/monthly-composite", { month: monthIso });
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Failed to load composite report");
    } finally {
      setLoading(false);
    }
  }, [monthIso]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const rows = useMemo(() => data?.rows || [], [data]);

  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter === "athlete") {
      list = list.filter(isAthleteLike);
    } else if (categoryFilter === "elite") {
      list = list.filter((r) => r.category === "elite");
    } else if (categoryFilter === "rest") {
      list = list.filter((r) => !isAthleteLike(r));
    }
    if (fleetFilter) {
      list = list.filter((r) =>
        fleetFilter === "__none__"
          ? !r.fleet
          : (r.fleet || "").toLowerCase() === fleetFilter.toLowerCase()
      );
    }
    if (institutionFilter) {
      list = list.filter((r) =>
        institutionFilter === "__none__"
          ? !r.institution
          : (r.institution || "") === institutionFilter
      );
    }
    return [...list].sort((a, b) =>
      (a.member_name || "").localeCompare(b.member_name || "")
    );
  }, [rows, categoryFilter, fleetFilter, institutionFilter, isAthleteLike]);

  const fleetOptions = useMemo(() => {
    const s = new Set();
    let hasBlank = false;
    for (const r of rows) {
      if (r.fleet) s.add(r.fleet);
      else hasBlank = true;
    }
    const out = [...s].sort((a, b) => a.localeCompare(b));
    if (hasBlank) out.push("__none__");
    return out;
  }, [rows]);

  const institutionOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.institution) set.add(r.institution);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const exportComposite = (fmt) => {
    const params = { month: monthIso, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    if (institutionFilter) params.institution = institutionFilter;
    return downloadBlob(
      "/reports/monthly-composite/export",
      `monthly_composite_${monthIso}.${fmt}`,
      params
    );
  };

  // Totals row across the currently-displayed rows.
  const totals = useMemo(() => {
    const t = {
      present: 0, half_day: 0, late: 0, absent: 0,
      leave_days: 0, tour: 0, posting: 0, comp_off_days: 0,
      weekly_off: 0, holiday: 0,
      ot_sessions: 0, ot_minutes: 0, ot_early_min: 0, ot_late_min: 0,
      ot_approved_min: 0, ot_pending_min: 0,
      comp_off_earned: 0,
      leave_applied: 0, leave_availed: 0, leave_rejected: 0,
      paid_leave_used: 0, comp_off_used: 0, lop_days: 0,
    };
    for (const r of displayedRows) {
      for (const k of Object.keys(t)) t[k] += r[k] || 0;
    }
    return t;
  }, [displayedRows]);

  return (
    <>
      <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="composite-controls">
        <MonthNav
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrev={onPrevMonth}
          onNext={onNextMonth}
          onToday={onJumpToday}
        />
        {data && (
          <div className="text-[11px] text-slate-500 hidden md:block">
            {data.start.split("-").reverse().join("/")} → {data.end.split("-").reverse().join("/")}
            &nbsp;·&nbsp; {displayedRows.length} of {rows.length} member{rows.length === 1 ? "" : "s"}
          </div>
        )}
        <button data-testid="composite-run" onClick={loadReport} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
        </button>
        <div className="flex-1" />
        <button data-testid="export-composite-csv" onClick={() => exportComposite("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="export-composite-pdf" onClick={() => exportComposite("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-2" data-testid="composite-category-filters">
          {CATEGORY_FILTERS.map((f) => {
            const active = categoryFilter === f.key;
            const count = f.key === "all"
              ? rows.length
              : f.key === "athlete"
                ? rows.filter(isAthleteLike).length
                : f.key === "elite"
                  ? rows.filter((r) => r.category === "elite").length
                  : rows.filter((r) => !isAthleteLike(r)).length;
            return (
              <button
                key={f.key}
                data-testid={`composite-cat-filter-${f.key}`}
                onClick={() => { setCategoryFilter(f.key); if (f.key !== "athlete") setFleetFilter(""); }}
                className={`iu-chip ${active ? "iu-chip-active" : ""}`}
              >
                {f.label}
                <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{count}</span>
              </button>
            );
          })}
          {categoryFilter === "athlete" && fleetOptions.length > 0 && (
            <select
              data-testid="composite-fleet-filter"
              value={fleetFilter}
              onChange={(e) => setFleetFilter(e.target.value)}
              className="iu-input !w-40 !py-1 !h-8 text-xs"
            >
              <option value="">All fleets</option>
              {fleetOptions.map((f) => (
                <option key={f} value={f}>{f === "__none__" ? "(No fleet)" : f}</option>
              ))}
            </select>
          )}
          {institutionOptions.length > 0 && (
            <select
              data-testid="composite-institution-filter"
              value={institutionFilter}
              onChange={(e) => setInstitutionFilter(e.target.value)}
              className="iu-input !w-44 !py-1 !h-8 text-xs"
              title="Filter by institution"
            >
              <option value="">All institutions</option>
              <option value="__none__">(No institution)</option>
              {institutionOptions.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="composite-table">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-slate-500 text-[10px] uppercase tracking-wider">
                <th className="py-2 px-2 text-left sticky left-0 z-10 bg-slate-50" colSpan={2}>Member</th>
                <th className="py-2 px-2 text-center bg-emerald-50" colSpan={4}>Attendance</th>
                <th className="py-2 px-2 text-center bg-amber-50" colSpan={6}>Leave / Off</th>
                <th className="py-2 px-2 text-center bg-orange-50" colSpan={6}>Overtime</th>
                <th className="py-2 px-2 text-center bg-sky-50" colSpan={1}>Comp-off</th>
                <th className="py-2 px-2 text-center bg-violet-50" colSpan={3}>Leave · Month</th>
                <th className="py-2 px-2 text-center bg-fuchsia-50" colSpan={3}>Leave · Deductions</th>
                <th className="py-2 px-2 text-center bg-rose-50" colSpan={3}>Leave · YTD Balance</th>
              </tr>
              <tr className="text-slate-600 text-[11px] border-t border-slate-100">
                <th className="py-1.5 px-2 text-left sticky left-0 z-10 bg-slate-50 font-semibold">Name</th>
                <th className="py-1.5 px-2 text-left bg-slate-50 font-semibold hidden md:table-cell">Category</th>
                {/* Attendance */}
                <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 text-emerald-700" title="Present">P</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 text-emerald-700" title="Half day">HD</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 text-amber-600" title="Late">Late</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 text-red-600" title="Absent">Abs</th>
                {/* Leave / Off */}
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-amber-700" title="Leave days">Leave</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-orange-700" title="Tour days">Tour</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-slate-600" title="Posting days">Post</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-sky-700" title="Comp-off availed">CO</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-slate-500" title="Weekly off">Wk-off</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-50/70 text-slate-500" title="Holiday">Hol</th>
                {/* Overtime — full detail */}
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-orange-700" title="OT sessions">Sess</th>
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-emerald-700" title="OT — early arrival minutes">Early</th>
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-amber-700" title="OT — late departure minutes">Late</th>
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-orange-700 font-bold" title="OT — grand total">Total</th>
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-emerald-600" title="OT — admin-approved">Appr</th>
                <th className="py-1.5 px-1.5 text-center bg-orange-50/70 text-amber-600" title="OT — awaiting approval">Pend</th>
                {/* Comp-off (earned only) */}
                <th className="py-1.5 px-1.5 text-center bg-sky-50/70 text-sky-700" title="Comp-off earned this month">CO earned</th>
                {/* Leave ledger — month rows */}
                <th className="py-1.5 px-1.5 text-center bg-violet-50/70 text-violet-700" title="Leaves applied (pending) — days">App</th>
                <th className="py-1.5 px-1.5 text-center bg-violet-50/70 text-violet-700 font-bold" title="Leaves availed (approved) — days">Avld</th>
                <th className="py-1.5 px-1.5 text-center bg-violet-50/70 text-slate-500" title="Leaves rejected — days">Rej</th>
                {/* Leave deductions (from availed leaves this month) */}
                <th className="py-1.5 px-1.5 text-center bg-fuchsia-50/70 text-fuchsia-700" title="Days deducted from paid leave pool">Paid</th>
                <th className="py-1.5 px-1.5 text-center bg-fuchsia-50/70 text-sky-700" title="Days deducted from comp-off pool">CO used</th>
                <th className="py-1.5 px-1.5 text-center bg-fuchsia-50/70 text-red-600" title="Loss of pay days">LOP</th>
                {/* Leave YTD balance */}
                <th className="py-1.5 px-1.5 text-center bg-rose-50/70 text-slate-600" title="Annual leave opening balance">Open</th>
                <th className="py-1.5 px-1.5 text-center bg-rose-50/70 text-slate-600" title="Leave days taken so far this year">Taken</th>
                <th className="py-1.5 px-1.5 text-center bg-rose-50/70 text-emerald-700 font-bold" title="Remaining annual leave balance">Rem</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={28} className="py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && displayedRows.length === 0 && (
                <tr><td colSpan={28} className="py-8 text-center text-slate-400" data-testid="composite-empty">No members match the current filters.</td></tr>
              )}
              {!loading && displayedRows.map((r, i) => {
                const rowBg = i % 2 === 1 ? "bg-slate-200/60" : "bg-white";
                const n = (v) => (v ? v : "");
                const nf = (v, digits = 1) => (v ? Number(v).toFixed(digits).replace(/\.?0+$/, "") : "");
                return (
                  <tr key={r.member_id} className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`composite-row-${r.member_id}`}>
                    <td className={`py-1.5 px-2 font-semibold text-slate-800 border-t border-slate-100 sticky left-0 z-10 ${rowBg} group-hover:bg-sky-50`}>
                      {r.member_name}
                      {r.rank && <div className="text-[10px] text-slate-400 leading-tight">{r.rank}</div>}
                    </td>
                    <td className="py-1.5 px-2 text-slate-600 border-t border-slate-100 hidden md:table-cell">{categoryLabel(r.category)}</td>
                    {/* Attendance */}
                    <td className="py-1.5 px-1.5 text-center bg-emerald-100/40 border-l border-t border-emerald-100 font-semibold text-emerald-700">{n(r.present)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-emerald-100/40 border-t border-emerald-100 text-slate-600">{n(r.half_day)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-emerald-100/40 border-t border-emerald-100 text-amber-600">{n(r.late)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-emerald-100/40 border-t border-emerald-100 text-red-600">{n(r.absent)}</td>
                    {/* Leave / Off */}
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-l border-t border-amber-100 text-amber-700">{n(r.leave_days)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-t border-amber-100 text-orange-700">{n(r.tour)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-t border-amber-100 text-slate-600">{n(r.posting)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-t border-amber-100 text-sky-700">{n(r.comp_off_days)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-t border-amber-100 text-slate-500">{n(r.weekly_off)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-amber-100/40 border-t border-amber-100 text-slate-500">{n(r.holiday)}</td>
                    {/* Overtime — 6 columns */}
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-l border-t border-orange-100 text-orange-700">{n(r.ot_sessions)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-t border-orange-100 text-emerald-700 tabular-nums">{fmtHM(r.ot_early_min)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-t border-orange-100 text-amber-700 tabular-nums">{fmtHM(r.ot_late_min)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-t border-orange-100 text-orange-700 font-bold tabular-nums">{fmtHM(r.ot_minutes)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-t border-orange-100 text-emerald-600 tabular-nums">{fmtHM(r.ot_approved_min)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-orange-100/40 border-t border-orange-100 text-amber-600 tabular-nums">{fmtHM(r.ot_pending_min)}</td>
                    {/* Comp-off earned */}
                    <td className="py-1.5 px-1.5 text-center bg-sky-100/40 border-l border-t border-sky-100 text-sky-700 font-semibold">{n(r.comp_off_earned)}</td>
                    {/* Leave · Month */}
                    <td className="py-1.5 px-1.5 text-center bg-violet-100/40 border-l border-t border-violet-100 text-violet-700">{n(r.leave_applied)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-violet-100/40 border-t border-violet-100 text-violet-700 font-semibold">{n(r.leave_availed)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-violet-100/40 border-t border-violet-100 text-slate-500">{n(r.leave_rejected)}</td>
                    {/* Leave · Deductions */}
                    <td className="py-1.5 px-1.5 text-center bg-fuchsia-100/40 border-l border-t border-fuchsia-100 text-fuchsia-700 tabular-nums">{nf(r.paid_leave_used)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-fuchsia-100/40 border-t border-fuchsia-100 text-sky-700 tabular-nums">{n(r.comp_off_used)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-fuchsia-100/40 border-t border-fuchsia-100 text-red-600 tabular-nums">{nf(r.lop_days)}</td>
                    {/* Leave · YTD Balance */}
                    <td className="py-1.5 px-1.5 text-center bg-rose-100/40 border-l border-t border-rose-100 text-slate-600 tabular-nums">{nf(r.leave_opening)}</td>
                    <td className="py-1.5 px-1.5 text-center bg-rose-100/40 border-t border-rose-100 text-slate-600 tabular-nums">{nf(r.leave_taken_ytd)}</td>
                    <td className={`py-1.5 px-1.5 text-center bg-rose-100/40 border-t border-rose-100 font-bold tabular-nums ${r.leave_remaining < 0 ? "text-red-600" : "text-emerald-700"}`}>{nf(r.leave_remaining)}</td>
                  </tr>
                );
              })}
              {!loading && displayedRows.length > 0 && (
                <tr className="bg-slate-100 font-bold text-slate-800 border-t-2 border-slate-300" data-testid="composite-totals-row">
                  <td className="py-2 px-2 sticky left-0 z-10 bg-slate-100" colSpan={2}>Totals</td>
                  <td className="py-2 px-1.5 text-center bg-emerald-200/50">{totals.present || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-emerald-200/50">{totals.half_day || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-emerald-200/50">{totals.late || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-emerald-200/50">{totals.absent || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.leave_days || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.tour || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.posting || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.comp_off_days || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.weekly_off || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-amber-200/50">{totals.holiday || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50">{totals.ot_sessions || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50 tabular-nums">{fmtHM(totals.ot_early_min)}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50 tabular-nums">{fmtHM(totals.ot_late_min)}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50 tabular-nums">{fmtHM(totals.ot_minutes)}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50 tabular-nums">{fmtHM(totals.ot_approved_min)}</td>
                  <td className="py-2 px-1.5 text-center bg-orange-200/50 tabular-nums">{fmtHM(totals.ot_pending_min)}</td>
                  <td className="py-2 px-1.5 text-center bg-sky-200/50">{totals.comp_off_earned || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-violet-200/50">{totals.leave_applied || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-violet-200/50">{totals.leave_availed || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-violet-200/50">{totals.leave_rejected || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-fuchsia-200/50 tabular-nums">{totals.paid_leave_used ? totals.paid_leave_used.toFixed(1) : ""}</td>
                  <td className="py-2 px-1.5 text-center bg-fuchsia-200/50 tabular-nums">{totals.comp_off_used || ""}</td>
                  <td className="py-2 px-1.5 text-center bg-fuchsia-200/50 tabular-nums">{totals.lop_days ? totals.lop_days.toFixed(1) : ""}</td>
                  {/* YTD totals across roster don't sum to a meaningful org-wide value — leave blank. */}
                  <td className="py-2 px-1.5 text-center bg-rose-200/50 text-slate-400">—</td>
                  <td className="py-2 px-1.5 text-center bg-rose-200/50 text-slate-400">—</td>
                  <td className="py-2 px-1.5 text-center bg-rose-200/50 text-slate-400">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
