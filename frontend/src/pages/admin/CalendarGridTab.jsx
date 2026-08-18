import React, { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob, showApiError } from "../../api";
import { useApiQuery } from "../../hooks/useApiQuery";
import { formatDate } from "../../utils";
import CorrectionRequestModal from "../../components/CorrectionRequestModal";
import AttendanceLedgerModal from "./AttendanceLedgerModal";
import OTLedgerModal from "./OTLedgerModal";
import MemberForm from "./MemberForm";
import { GridCell, GridTimeCell, CELL_STYLE, correctionForCode } from "./calendar-grid/gridHelpers";
import GridFilterBar from "./calendar-grid/GridFilterBar";
import GridRowTotals from "./calendar-grid/GridRowTotals";
import { useUiPrefs } from "../../hooks/useUiPrefs";

/**
 * Calendar Grid tab — one row per member, one column per day of the
 * month. Each cell shows a 2-letter code (LV, AB, TR, HD, LT, WO, HO,
 * CO, PS) or a green pill for a present day. Future days render blank.
 */

export default function CalendarGridTab({ monthIso, monthLabel, isCurrent, onPrevMonth, onNextMonth, onJumpToday, MonthNav, athleteLikeKeys }) {
  // Category filter defaults to "rest" (Staff & Coaches) per user
  // request — the population admins actually manage day to day.
  // Persisted per-user via useUiPrefs so tweaks stick across reloads
  // but the pill row remains fully editable.
  const [uiPrefs, patchUiPrefs] = useUiPrefs({ reports_calendar_category: "rest" });
  const categoryFilter = uiPrefs.reports_calendar_category || "rest";
  const setCategoryFilter = useCallback((v) => {
    patchUiPrefs({ reports_calendar_category: v });
  }, [patchUiPrefs]);
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  // Name / rank search (13 Feb 2026) — case-insensitive substring
  // match against member_name + rank so admins can jump to a specific
  // person in a big filtered list without paging.
  const [nameSearch, setNameSearch] = useState("");
  // 1-row vs 2-row layout (13 Feb 2026). Two-row mode shows a
  // dedicated check-IN row and check-OUT row per member for days the
  // member was on-campus (P / HD / LT). Non-attendance codes
  // (LV / TR / WO …) span both rows so the visual stays honest.
  // Persisted per-admin via localStorage so the preference sticks.
  const [rowsMode, setRowsMode] = useState(() => {
    try { return localStorage.getItem("gridRowsMode") || "single"; }
    catch { return "single"; }
  });
  const toggleRowsMode = () => {
    setRowsMode((prev) => {
      const next = prev === "single" ? "double" : "single";
      try { localStorage.setItem("gridRowsMode", next); } catch { /* private mode */ }
      return next;
    });
  };
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
  // Double-click on the name cell opens the full member-edit modal
  // (same one Manage Members uses) — quick edit-in-place without
  // switching tabs. 20 Feb 2026 user request.
  const [editingMemberId, setEditingMemberId] = useState(null);
  const [editingMember, setEditingMember] = useState(null);
  useEffect(() => {
    if (!editingMemberId) { setEditingMember(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const m = await api.get(`/members/${editingMemberId}`);
        if (!cancelled) setEditingMember(m);
      } catch (err) {
        showApiError(err, "Couldn't load member for edit");
        if (!cancelled) setEditingMemberId(null);
      }
    })();
    return () => { cancelled = true; };
  }, [editingMemberId]);

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
    const q = (nameSearch || "").trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        (r.member_name || "").toLowerCase().includes(q) ||
        (r.rank || "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
  }, [rows, categoryFilter, fleetFilter, institutionFilter, nameSearch, isAthleteLike]);

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

      <GridFilterBar
        rows={rows}
        isAthleteLike={isAthleteLike}
        categoryFilter={categoryFilter}
        onCategoryFilter={setCategoryFilter}
        fleetFilter={fleetFilter}
        onFleetFilter={setFleetFilter}
        fleetOptions={fleetOptions}
        institutionFilter={institutionFilter}
        onInstitutionFilter={setInstitutionFilter}
        institutionOptions={institutionOptions}
        nameSearch={nameSearch}
        onNameSearch={setNameSearch}
        rowsMode={rowsMode}
        onToggleRowsMode={toggleRowsMode}
      />

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
                <th className="py-1.5 px-2 text-center sticky left-0 z-40 bg-slate-50 w-10 min-w-[40px] max-w-[40px] border-b border-slate-200 font-semibold text-slate-500 text-[10px] uppercase tracking-wider">#</th>
                <th className="py-1.5 px-2 text-left sticky left-10 z-40 bg-slate-50 w-[180px] min-w-[180px] max-w-[180px] border-b border-slate-200 font-semibold text-slate-700">Member</th>
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
                    LT (Late) → EO (Early Out) → OT (mins) → TR → LV → AB → P.
                    Offsets: LT=0, EO=42, OT=84, TR=136, LV=178, AB=220, P=262. */}
                <th className="sticky right-[262px] z-40 bg-emerald-100 text-emerald-800 h-6 min-w-[42px] text-center border-b border-l-2 border-slate-300 text-[10px] font-bold" title="Present days (incl. HD + Late)">P</th>
                <th className="sticky right-[220px] z-40 bg-red-100 text-red-700 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Absent days">AB</th>
                <th className="sticky right-[178px] z-40 bg-amber-100 text-amber-700 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Leave + Comp-off days">LV</th>
                <th className="sticky right-[136px] z-40 bg-orange-200 text-orange-800 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Tour days">TR</th>
                <th className="sticky right-[84px] z-40 bg-violet-100 text-violet-800 h-6 min-w-[52px] text-center border-b border-slate-200 text-[10px] font-bold" title="Overtime hours accumulated (early arrival + late departure)">OT h</th>
                <th className="sticky right-[42px] z-40 bg-rose-100 text-rose-700 h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Early-out days this month (checked out ≥15m before end time)">EO</th>
                <th className="sticky right-0 z-40 bg-orange-500/90 text-white h-6 min-w-[42px] text-center border-b border-slate-200 text-[10px] font-bold" title="Late days this month (subset of Present)">LT</th>
              </tr>
              <tr>
                <th className="py-0.5 sticky left-0 z-40 bg-slate-50 w-10 min-w-[40px] max-w-[40px] border-b border-slate-200"></th>
                <th className="py-0.5 px-2 sticky left-10 z-40 bg-slate-50 w-[180px] min-w-[180px] max-w-[180px] text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-200">Name / Rank</th>
                {dayHeaders.map((h) => (
                  <th
                    key={h.iso + "-dow"}
                    className={`text-center h-4 border-b border-r border-slate-200 text-[9px] uppercase font-semibold ${h.isWeekend ? "bg-slate-100 text-slate-400" : "bg-slate-50 text-slate-500"}`}
                  >
                    {h.dow.slice(0, 2)}
                  </th>
                ))}
                {/* Sticky-right total sub-labels */}
                <th className="sticky right-[262px] z-40 bg-emerald-50 h-4 text-[8px] uppercase font-semibold text-emerald-700 border-b border-l-2 border-slate-300 text-center">Total</th>
                <th className="sticky right-[220px] z-40 bg-red-50 h-4 text-[8px] uppercase font-semibold text-red-600 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[178px] z-40 bg-amber-50 h-4 text-[8px] uppercase font-semibold text-amber-700 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[136px] z-40 bg-orange-100 h-4 text-[8px] uppercase font-semibold text-orange-700 border-b border-slate-200 text-center">Total</th>
                <th className="sticky right-[84px] z-40 bg-violet-50 h-4 text-[8px] uppercase font-semibold text-violet-700 border-b border-slate-200 text-center">Sum</th>
                <th className="sticky right-[42px] z-40 bg-rose-50 h-4 text-[8px] uppercase font-semibold text-rose-700 border-b border-slate-200 text-center">Days</th>
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
                    <td className="py-1 px-2" colSpan={2 + days.length + 7}>
                      <div className="h-4 rounded bg-slate-200/70 animate-pulse w-full" />
                    </td>
                  </tr>
                ))
              )}
              {!loading && displayedRows.length === 0 && (
                <tr><td colSpan={2 + days.length + 7} className="py-8 text-center text-slate-400" data-testid="calendar-empty">No members match the current filters.</td></tr>
              )}
              {displayedRows.map((r, i) => {
                const rowBg = i % 2 === 1 ? "bg-slate-100/40" : "bg-white";
                const isDouble = rowsMode === "double";
                const openAttn = () => setAttnLedger({
                  member_id: r.member_id,
                  member_name: r.member_name,
                });
                const openOt = () => setOtLedger({
                  member_id: r.member_id,
                  member_name: r.member_name,
                });
                // Build once — reused across the top and bottom rows in
                // double mode. Each entry carries everything the two
                // GridCell / GridTimeCell renders need.
                const dayCells = r.cells.map((code, idx) => {
                  const iso = days[idx];
                  const meta = r.cell_meta ? r.cell_meta[iso] : undefined;
                  const cfg = correctionForCode(code);
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
                        // 24 Feb 2026: when the click lands on a leave-family
                        // cell (LV / LP / TR / CO / PS), the backend already
                        // stashed the target leave id in cell_meta — pass it
                        // straight through as `entityId` so the modal skips
                        // the candidate-picker step and goes direct to "cancel
                        // this leave application".
                        entityId: meta?.leave_id,
                      })
                    : undefined;
                  return { code, iso, meta, onClick, dow: dayHeaders[idx]?.dow };
                });
                const isAttnCode = (c) => c === "P" || c === "HD" || c === "LT";

                const totalsRowSpan = isDouble ? 2 : 1;
                const totalsCells = (
                  <GridRowTotals
                    totals={r.totals}
                    memberId={r.member_id}
                    rowBg={rowBg}
                    rowSpan={totalsRowSpan}
                    onOpenAttn={openAttn}
                    onOpenOt={openOt}
                  />
                );

                return (
                  <React.Fragment key={r.member_id}>
                    <tr className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`calendar-row-${r.member_id}`}>
                      <td
                        rowSpan={isDouble ? 2 : 1}
                        className={`py-1 px-2 text-center text-[11px] text-slate-500 tabular-nums sticky left-0 z-20 w-10 min-w-[40px] max-w-[40px] ${rowBg} group-hover:bg-sky-50 border-b border-slate-100`}
                        data-testid={`calendar-serial-${r.member_id}`}
                      >{i + 1}</td>
                      <td
                        rowSpan={isDouble ? 2 : 1}
                        className={`py-1 px-2 font-semibold text-slate-800 sticky left-10 z-20 w-[180px] min-w-[180px] max-w-[180px] ${rowBg} group-hover:bg-sky-50 border-b border-slate-100 cursor-pointer select-none`}
                        onDoubleClick={() => setEditingMemberId(r.member_id)}
                        title="Double-click to edit member"
                        data-testid={`calendar-name-${r.member_id}`}
                      >
                        {r.member_name}
                        {r.rank && <div className="text-[10px] text-slate-400 leading-tight">{r.rank}</div>}
                        {isDouble && <div className="text-[9px] text-emerald-600 font-bold mt-0.5 tracking-wider">▲ IN &nbsp;&nbsp; ▼ OUT</div>}
                      </td>
                      {dayCells.map((c) => {
                        if (isDouble && isAttnCode(c.code)) {
                          // Two-row mode, attendance day → top cell = check-in time.
                          return (
                            <GridTimeCell
                              key={c.iso}
                              code={c.code}
                              time={c.meta?.check_in_at}
                              dow={c.dow}
                              iso={c.iso}
                              meta={c.meta}
                              onClick={c.onClick}
                              half="in"
                              half_kind="in"
                            />
                          );
                        }
                        // Single-row mode, or non-attendance day in double mode.
                        // In the latter case, span both rows so the code stays
                        // visually anchored across the in/out pair.
                        return (
                          <GridCell
                            key={c.iso}
                            code={c.code}
                            dow={c.dow}
                            iso={c.iso}
                            meta={c.meta}
                            onClick={c.onClick}
                            rowSpan={isDouble ? 2 : undefined}
                          />
                        );
                      })}
                      {totalsCells}
                    </tr>
                    {isDouble && (
                      <tr className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`calendar-row-${r.member_id}-out`}>
                        {dayCells.map((c) => {
                          if (isAttnCode(c.code)) {
                            return (
                              <GridTimeCell
                                key={c.iso + "-out"}
                                code={c.code}
                                time={c.meta?.check_out_at}
                                dow={c.dow}
                                iso={c.iso}
                                meta={c.meta}
                                onClick={c.onClick}
                                half="out"
                                half_kind="out"
                              />
                            );
                          }
                          // Non-attendance cell was rowSpan=2 in the top
                          // row — emit nothing here to preserve column
                          // alignment.
                          return null;
                        })}
                      </tr>
                    )}
                  </React.Fragment>
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
          /* Clip the ledger end date to today for the CURRENT month so
             future dates (empty rows) don't pad the modal — user
             request 20 Feb 2026. Historical months keep the full
             month-end so past data displays completely. */
          end={isCurrent ? (data?.today || new Date().toISOString().slice(0, 10)) : data?.end}
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
          entityId={correction.entityId}
          initialKind={correction.initialKind}
          targetDate={correction.date}
          onBehalfOfMember={correction.member}
          entityLabel={`${correction.member.full_name} · ${correction.date}`}
          defaultCheckInTime={correction.member.work_start}
          defaultCheckOutTime={correction.member.work_end}
        />
      )}

      {editingMember && (
        <MemberForm
          initial={editingMember}
          onClose={() => setEditingMemberId(null)}
          onSaved={() => {
            setEditingMemberId(null);
            toast.success("Member updated");
            // Refetch the Grid so any name/rank/category tweaks
            // reflect in the row immediately.
            loadReport();
          }}
        />
      )}
    </>
  );
}
