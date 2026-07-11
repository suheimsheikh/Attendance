import React, { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { downloadBlob, showApiError } from "../../api";
import { useApiQuery } from "../../hooks/useApiQuery";
import { categoryLabel, formatDate } from "../../utils";
import CorrectionRequestModal from "../../components/CorrectionRequestModal";
import AttendanceLedgerModal from "./AttendanceLedgerModal";
import OTLedgerModal from "./OTLedgerModal";
import { GridCell, CELL_STYLE, correctionForCode, fmtOt } from "./calendar-grid/gridHelpers";

/**
 * Calendar Grid tab — one row per member, one column per day of the
 * month. Each cell shows a 2-letter code (LV, AB, TR, HD, LT, WO, HO,
 * CO, PS) or a green pill for a present day. Future days render blank.
 */

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "elite",   label: "Elite" },
  { key: "rest",    label: "Staff & Coaches" },
];

export default function CalendarGridTab({ monthIso, monthLabel, isCurrent, onPrevMonth, onNextMonth, onJumpToday, MonthNav, athleteLikeKeys }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  // Correction modal state — clicking any cell with a useful code
  // (AB/LT/P/HD/LV/TR/CO/PS) opens the shared CorrectionRequestModal
  // pre-filled with the member and date the admin clicked.
  const [correction, setCorrection] = useState(null); // { member, date, entityType, initialKind } | null
  // Ledger modal state — double-clicking any totals cell opens the
  // matching drill-down modal for that member (mirrors the Attendance
  // report double-click UX). AttendanceLedger for P/AB/LV/TR, OT
  // ledger for the OT-hours cell.
  const [attnLedger, setAttnLedger] = useState(null); // { member_id, member_name } | null
  const [otLedger, setOtLedger] = useState(null);     // { member_id, member_name } | null

  const isAthleteLike = useCallback(
    (r) => athleteLikeKeys.has(r?.category),
    [athleteLikeKeys]
  );

  // React Query — historical months are effectively immutable, so we
  // cache aggressively (5 min stale, 30 min gc). Current month keeps
  // the default 60 s stale time (from index.js) so admins see today's
  // check-ins reflected within a page-flip. `placeholderData:
  // keepPreviousData` (K in the 20 Feb 2026 perf combo) keeps the
  // previous month's rows on screen while the new month loads — Grid
  // month-scroll now feels like a native app instead of blanking.
  const isHistorical = !isCurrent;
  const query = useApiQuery(
    "/reports/calendar-grid",
    { month: monthIso },
    {
      placeholderData: keepPreviousData,
      ...(isHistorical ? { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } : {}),
    },
  );
  const { data, isFetching, refetch, error } = query;
  const loading = isFetching;

  useEffect(() => {
    if (error) showApiError(error, "Failed to load calendar grid");
  }, [error]);

  const loadReport = useCallback(() => { refetch(); }, [refetch]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const days = useMemo(() => data?.days || [], [data]);
  const todayIso = data?.today;

  // Per-day weekday label ("Mo", "Tu"…) for the sub-header row.
  const dayHeaders = useMemo(() => days.map((iso) => {
    const dt = new Date(iso + "T00:00:00");
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
    return { day: iso.slice(8, 10), dow, iso, isWeekend: dt.getDay() === 0 || dt.getDay() === 6, isToday: iso === todayIso };
  }), [days, todayIso]);

  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter === "athlete") list = list.filter(isAthleteLike);
    else if (categoryFilter === "elite") list = list.filter((r) => r.category === "elite");
    else if (categoryFilter === "rest") list = list.filter((r) => !isAthleteLike(r));
    if (fleetFilter) {
      list = list.filter((r) =>
        fleetFilter === "__none__" ? !r.fleet : (r.fleet || "").toLowerCase() === fleetFilter.toLowerCase()
      );
    }
    if (institutionFilter) {
      list = list.filter((r) =>
        institutionFilter === "__none__" ? !r.institution : (r.institution || "") === institutionFilter
      );
    }
    return [...list].sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
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

  const exportGrid = (fmt) => {
    const params = { month: monthIso, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    if (institutionFilter) params.institution = institutionFilter;
    return downloadBlob(
      "/reports/calendar-grid/export",
      `calendar_grid_${monthIso}.${fmt}`,
      params
    );
  };

  return (
    <>
      <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="calendar-grid-controls">
        <MonthNav
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrev={onPrevMonth}
          onNext={onNextMonth}
          onToday={onJumpToday}
        />
        {data && (
          <div className="text-[11px] text-slate-500 hidden md:block">
            {formatDate(data.start)} → {formatDate(data.end)}
            &nbsp;·&nbsp; {displayedRows.length} of {rows.length} member{rows.length === 1 ? "" : "s"}
          </div>
        )}
        <button data-testid="calendar-grid-run" onClick={loadReport} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
        </button>
        <div className="flex-1" />
        <button data-testid="export-calendar-csv" onClick={() => exportGrid("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="export-calendar-pdf" onClick={() => exportGrid("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-2" data-testid="calendar-category-filters">
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
                data-testid={`calendar-cat-filter-${f.key}`}
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
              data-testid="calendar-fleet-filter"
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
              data-testid="calendar-institution-filter"
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

      {/* Legend */}
      <div className="flex flex-wrap gap-2 mb-3 text-[11px]" data-testid="calendar-legend">
        {Object.entries(CELL_STYLE).map(([code, s]) => (
          <span key={code} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex items-center justify-center w-6 h-5 rounded ${s.bg} ${s.text} font-bold text-[10px]`}>{s.label}</span>
            <span className="text-slate-600">{s.title}</span>
          </span>
        ))}
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 340px)" }}>
          <table className="text-xs border-collapse" data-testid="calendar-grid-table">
            <thead className="sticky top-0 z-30 bg-slate-50">
              <tr>
                <th className="py-1.5 px-2 text-center sticky left-0 z-40 bg-slate-50 w-10 border-b border-slate-200 font-semibold text-slate-500 text-[10px] uppercase tracking-wider">#</th>
                <th className="py-1.5 px-2 text-left sticky left-10 z-40 bg-slate-50 min-w-[180px] border-b border-slate-200 font-semibold text-slate-700">Member</th>
                <th className="py-1.5 px-2 text-left sticky left-[220px] z-40 bg-slate-50 min-w-[100px] hidden md:table-cell border-b border-slate-200 font-semibold text-slate-700">Category</th>
                {dayHeaders.map((h) => (
                  <th
                    key={h.iso}
                    className={`text-center h-6 w-7 border-b border-r border-slate-200 tabular-nums font-bold ${h.isWeekend ? "bg-slate-100 text-slate-400" : "bg-slate-50 text-slate-700"} ${h.isToday ? "!bg-sky-100 !text-sky-800" : ""}`}
                    title={`${h.dow} · ${h.iso}`}
                    data-testid={`cal-header-${h.iso}`}
                  >
                    {h.day}
                  </th>
                ))}
                {/* Sticky-right totals headers. Layout (rightmost-first):
                    LT (Late count) → OT (mins) → TR → LV → AB → P.
                    Offsets: LT=0, OT=42, TR=94, LV=136, AB=178, P=220. */}
                <th className="sticky right-[220px] z-40 bg-emerald-100 text-emerald-800 h-6 min-w-[42px] text-center border-b border-l-2 border-slate-300 text-[10px] font-bold" title="Present days (incl. HD + Late)">P</th>
                <th className="sticky right-[178px] z-40 bg-red-100 text-red-700 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Absent days">AB</th>
                <th className="sticky right-[136px] z-40 bg-amber-100 text-amber-700 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Leave + Comp-off days">LV</th>
                <th className="sticky right-[94px] z-40 bg-orange-200 text-orange-800 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Tour days">TR</th>
                <th className="sticky right-[42px] z-40 bg-violet-100 text-violet-800 h-6 min-w-[52px] text-center border-b border-slate-200 text-[10px] font-bold" title="Overtime hours accumulated (early arrival + late departure)">OT h</th>
                <th className="sticky right-0 z-40 bg-orange-500/90 text-white h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Late days this month (subset of Present)">LT</th>
              </tr>
              <tr>
                <th className="py-0.5 sticky left-0 z-40 bg-slate-50 border-b border-slate-200"></th>
                <th className="py-0.5 px-2 sticky left-10 z-40 bg-slate-50 text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-200">Name / Rank</th>
                <th className="py-0.5 px-2 sticky left-[220px] z-40 bg-slate-50 hidden md:table-cell border-b border-slate-200"></th>
                {dayHeaders.map((h) => (
                  <th
                    key={h.iso + "-dow"}
                    className={`text-center h-4 border-b border-r border-slate-200 text-[9px] uppercase font-semibold ${h.isWeekend ? "bg-slate-100 text-slate-400" : "bg-slate-50 text-slate-500"}`}
                  >
                    {h.dow.slice(0, 2)}
                  </th>
                ))}
                {/* Sticky-right total sub-labels */}
                <th className="sticky right-[220px] z-40 bg-emerald-50 h-4 text-[8px] uppercase font-semibold text-emerald-700 border-b border-l-2 border-slate-300 text-center">Total</th>
                <th className="sticky right-[178px] z-40 bg-red-50 h-4 text-[8px] uppercase font-semibold text-red-600 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[136px] z-40 bg-amber-50 h-4 text-[8px] uppercase font-semibold text-amber-700 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[94px] z-40 bg-orange-100 h-4 text-[8px] uppercase font-semibold text-orange-700 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[42px] z-40 bg-violet-50 h-4 text-[8px] uppercase font-semibold text-violet-700 border-b border-slate-200 text-center">Sum</th>
                <th className="sticky right-0 z-40 bg-orange-100 h-4 text-[8px] uppercase font-semibold text-orange-700 border-b border-slate-200 text-center">Days</th>
              </tr>
            </thead>
            <tbody>
              {loading && displayedRows.length === 0 && (
                // Skeleton rows — appears in <100 ms while the real
                // payload loads. Feels much snappier than a single
                // "Loading…" placeholder. 8 dummy rows is enough to
                // cover an above-the-fold slot without shifting layout
                // when the real rows arrive. (Perf combo item D,
                // 20 Feb 2026.)
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className={i % 2 === 1 ? "bg-slate-100/40" : "bg-white"} data-testid="calendar-skeleton-row">
                    <td className="py-1 px-2" colSpan={3 + days.length + 6}>
                      <div className="h-4 rounded bg-slate-200/70 animate-pulse w-full" />
                    </td>
                  </tr>
                ))
              )}
              {!loading && displayedRows.length === 0 && (
                <tr><td colSpan={3 + days.length + 6} className="py-8 text-center text-slate-400" data-testid="calendar-empty">No members match the current filters.</td></tr>
              )}
              {displayedRows.map((r, i) => {
                const rowBg = i % 2 === 1 ? "bg-slate-100/40" : "bg-white";
                return (
                  <tr key={r.member_id} className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`calendar-row-${r.member_id}`}>
                    <td className={`py-1 px-2 text-center text-[11px] text-slate-500 tabular-nums sticky left-0 z-20 ${rowBg} group-hover:bg-sky-50 border-b border-slate-100`} data-testid={`calendar-serial-${r.member_id}`}>{i + 1}</td>
                    <td className={`py-1 px-2 font-semibold text-slate-800 sticky left-10 z-20 ${rowBg} group-hover:bg-sky-50 border-b border-slate-100`}>
                      {r.member_name}
                      {r.rank && <div className="text-[10px] text-slate-400 leading-tight">{r.rank}</div>}
                    </td>
                    <td className={`py-1 px-2 text-slate-600 hidden md:table-cell border-b border-slate-100 sticky left-[220px] z-20 ${rowBg} group-hover:bg-sky-50`}>{categoryLabel(r.category)}</td>
                    {r.cells.map((code, idx) => {
                      const cfg = correctionForCode(code);
                      const iso = days[idx];
                      const meta = r.cell_meta ? r.cell_meta[iso] : undefined;
                      // Only wire onClick for past-or-today cells that
                      // map to a useful correction. Future dates
                      // (empty code) already skip in GridCell; WO/HO
                      // return null cfg.
                      const onClick = cfg
                        ? () => setCorrection({
                            member: {
                              id: r.member_id,
                              full_name: r.member_name,
                              work_start: r.work_start,
                              work_end: r.work_end,
                            },
                            date: iso,
                            entityType: cfg.entityType,
                            initialKind: cfg.initialKind,
                          })
                        : undefined;
                      return (
                        <GridCell
                          key={iso}
                          code={code}
                          dow={dayHeaders[idx]?.dow}
                          iso={iso}
                          meta={meta}
                          onClick={onClick}
                        />
                      );
                    })}
                    {/* Row totals — pinned to the right. Double-click any
                        of the day-count cells to open the Attendance
                        ledger for this member across the current month;
                        the OT cell opens the OT ledger. Mirrors the
                        Attendance report drill-down UX (04 Feb 2026). */}
                    {(() => {
                      const openAttn = () => setAttnLedger({
                        member_id: r.member_id,
                        member_name: r.member_name,
                      });
                      const openOt = () => setOtLedger({
                        member_id: r.member_id,
                        member_name: r.member_name,
                      });
                      const attnTitle = "Double-click for daily ledger";
                      const otTitle = "Double-click for OT ledger";
                      return (
                        <>
                          <td
                            className={`sticky right-[220px] z-20 ${rowBg} group-hover:bg-sky-50 text-center text-emerald-700 font-bold tabular-nums text-[11px] border-b border-l-2 border-slate-300 cursor-pointer select-none`}
                            data-testid={`cal-total-p-${r.member_id}`}
                            title={`Present · ${attnTitle}`}
                            onDoubleClick={openAttn}
                          >{r.totals?.present || ""}</td>
                          <td
                            className={`sticky right-[178px] z-20 ${rowBg} group-hover:bg-sky-50 text-center text-red-600 font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none`}
                            data-testid={`cal-total-ab-${r.member_id}`}
                            title={`Absent · ${attnTitle}`}
                            onDoubleClick={openAttn}
                          >{r.totals?.absent || ""}</td>
                          <td
                            className={`sticky right-[136px] z-20 ${rowBg} group-hover:bg-sky-50 text-center text-amber-700 font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none`}
                            data-testid={`cal-total-lv-${r.member_id}`}
                            title={r.totals?.lop ? `Leave (${r.totals.lop} LOP) · ${attnTitle}` : `Leave · ${attnTitle}`}
                            onDoubleClick={openAttn}
                          >
                            {r.totals?.leave || ""}
                            {/* LOP badge — appears inline when any LOP
                                days were stamped on this row's leaves
                                so admins spot pay impact at a glance. */}
                            {r.totals?.lop ? (
                              <span
                                className="ml-1 inline-flex items-center px-1 rounded-full bg-rose-600 text-white text-[9px] font-bold"
                                title={`${r.totals.lop} day${r.totals.lop === 1 ? "" : "s"} without pay`}
                                data-testid={`cal-total-lop-${r.member_id}`}
                              >
                                {r.totals.lop} LOP
                              </span>
                            ) : null}
                          </td>
                          <td
                            className={`sticky right-[94px] z-20 ${rowBg} group-hover:bg-sky-50 text-center text-orange-700 font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none`}
                            data-testid={`cal-total-tr-${r.member_id}`}
                            title={`Tour · ${attnTitle}`}
                            onDoubleClick={openAttn}
                          >{r.totals?.tour || ""}</td>
                          <td
                            className={`sticky right-[42px] z-20 ${rowBg} group-hover:bg-sky-50 text-center text-violet-800 font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none`}
                            data-testid={`cal-total-ot-${r.member_id}`}
                            title={`OT hours · ${otTitle}`}
                            onDoubleClick={openOt}
                          >{fmtOt(r.totals?.ot_minutes)}</td>
                          <td
                            className={`sticky right-0 z-20 ${rowBg} group-hover:bg-sky-50 text-center text-orange-700 font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none`}
                            data-testid={`cal-total-lt-${r.member_id}`}
                            title={`Late days · ${attnTitle}`}
                            onDoubleClick={openAttn}
                          >{r.totals?.late || ""}</td>
                        </>
                      );
                    })()}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {attnLedger && (
        <AttendanceLedgerModal
          open
          onClose={() => setAttnLedger(null)}
          memberId={attnLedger.member_id}
          memberName={attnLedger.member_name}
          start={data?.start}
          end={data?.end}
        />
      )}

      {otLedger && (
        <OTLedgerModal
          open
          onClose={() => setOtLedger(null)}
          memberId={otLedger.member_id}
          memberName={otLedger.member_name}
          month={monthIso}
        />
      )}

      {correction && (
        <CorrectionRequestModal
          open
          onClose={() => setCorrection(null)}
          onSaved={(res) => {
            const msg = res?.auto_approved
              ? "Correction applied"
              : "Correction filed — pending admin approval";
            toast.success(msg);
            setCorrection(null);
            loadReport();
          }}
          entityType={correction.entityType}
          initialKind={correction.initialKind}
          targetDate={correction.date}
          onBehalfOfMember={correction.member}
          entityLabel={`${correction.member.full_name} · ${correction.date}`}
          defaultCheckInTime={correction.member.work_start}
          defaultCheckOutTime={correction.member.work_end}
        />
      )}
    </>
  );
}
