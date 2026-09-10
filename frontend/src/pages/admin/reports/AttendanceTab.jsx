import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../../api";
import { categoryLabel, formatDate } from "../../../utils";
import MemberTimelineModal from "../../../components/MemberTimelineModal";
import OTLedgerModal from "../OTLedgerModal";
import AttendanceLedgerModal from "../AttendanceLedgerModal";
import CompOffLedgerModal from "../CompOffLedgerModal";
import LeaveLedgerModal from "../LeaveLedgerModal";
import DrillDownBubble from "./DrillDownBubble";
import MonthNav from "./MonthNav";
import { CATEGORY_FILTERS, SORT_OPTIONS } from "./constants";
import ExMemberToggle, { useExMemberToggle } from "../../../components/ExMemberToggle";
import ExMemberChip from "../../../components/ExMemberChip";
import { isExMember } from "../../../utils/exMember";
import { useUiPrefs } from "../../../hooks/useUiPrefs";

/**
 * The Attendance tab of Reports — big monthly table with per-member
 * Attendance / Leave / OT / Comp-off / Hours columns, category & fleet
 * & institution filters, and 4 double-click ledger modals.
 *
 * Owns all of its own state (fetch, filters, modals, hover popover).
 * Parent passes month-nav state so it stays in sync with the Calendar
 * tab, plus two cross-cutting props:
 *   - `showHours`  (super-admin gate for the Hours group)
 *   - `athleteLikeKeys` (Set — drives Athletes/Elite vs Staff bucket)
 */
export default function AttendanceTab({
  monthIso,
  monthLabel,
  isCurrent,
  onPrevMonth,
  onNextMonth,
  onJumpToday,
  win,               // { start, end, ... } — used by Escort report fetch
  showHours,
  athleteLikeKeys,
}) {
  const isAthleteLike = useCallback((r) => athleteLikeKeys.has(r?.category), [athleteLikeKeys]);

  const [loading, setLoading] = useState(false);
  const [attendance, setAttendance] = useState(null);
  // Category filter now defaults to "rest" (Staff & Coaches) per user
  // request — that's the population admins actually manage day to day.
  // Persisted per-user via useUiPrefs so a coach's tweak sticks across
  // reloads but is still fully editable from the pill row.
  const [uiPrefs, patchUiPrefs] = useUiPrefs({ reports_attendance_category: "rest" });
  const categoryFilter = uiPrefs.reports_attendance_category || "rest";
  const setCategoryFilter = useCallback((v) => {
    patchUiPrefs({ reports_attendance_category: v });
  }, [patchUiPrefs]);
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  // OT-only filter — replaces the previous Comp-off filter (8 Jul 2026
  // user-requested). Surfaces rows with any non-zero OT signal
  // (served / applied / approved) this month.
  const [otOnly, setOtOnly] = useState(false);
  const [showEx, setShowEx] = useExMemberToggle("reports_attendance");
  const [sortBy, setSortBy] = useState("alpha");
  // YTD comp-off available per member — fetched once from /leave-balances
  // and merged into the on-screen Leave columns (Open · COff · Total ·
  // Avld · Close). Athletes are absent from this endpoint by design
  // (Breaks workflow), so their COff falls through to 0.
  const [compOffMap, setCompOffMap] = useState({});
  useEffect(() => {
    api.get("/leave-balances").then((r) => {
      const map = {};
      for (const row of (r?.rows || [])) map[row.id] = row.comp_off_available || 0;
      setCompOffMap(map);
    }).catch(() => { /* non-fatal — COff column falls back to 0 */ });
  }, []);
  // Escort-only mode fetches a separate report (list of parent-escorts
  // and their present-days) instead of blending with the member table.
  const [escortReport, setEscortReport] = useState(null);
  // Double-click OT-ledger modal state.
  const [otLedger, setOtLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Comp-off ledger modal state (8 Jul 2026 user request:
  // "A double click on the comp off col for anybody should create a
  // window with all the comp off dates and DOW").
  const [coLedger, setCoLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Leave ledger modal state (8 Jul 2026 user request:
  // "Double click on the leave cols should show all the leave date like
  // diff rows chronologically of Leave applied, Leave availed Leave
  // rejected and totals thereof").
  const [lvLedger, setLvLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Attendance ledger modal state (04 Feb 2026 user request:
  // "Double click on the attendance columns should show a table with
  // the months data of the said member date wise clearly indicating
  // tour and leave and absent etc").
  const [attnLedger, setAttnLedger] = useState(null); // { member_id, member_name } | null

  // Drill-down hover popover state (7 Jul 2026 — replaces native
  // `title` attrs which had 1-2s browser-delay and broke inside the
  // scroll container). One shared portal-rendered bubble that follows
  // the hovered cell; instant show/hide.
  const [tip, setTip] = useState(null); // { x, y, label, dates } | null
  const showTip = useCallback((e, label, dates) => {
    const arr = Array.isArray(dates) ? dates : [];
    if (arr.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({
      x: r.left + r.width / 2,
      y: r.top,
      label,
      dates: arr,
    });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  // Day-by-day timeline modal (7 Jul 2026 user-requested "why is X
  // absent again?"). Triggered by double-clicking the member name.
  // `timelineMember` holds the row that's currently drilled into;
  // `null` closes the modal.
  const [timelineMember, setTimelineMember] = useState(null);

  const loadAttendance = useCallback(async () => {
    setLoading(true);
    try { setAttendance(await api.get("/reports/payroll", { month: monthIso })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [monthIso]);

  // Fetched lazily when the admin flips the Escorts filter chip.
  // Escort attendance lives in its own collection so we hit a separate
  // endpoint rather than trying to shoe-horn it into the member table.
  const loadEscortReport = useCallback(async () => {
    if (!win?.start || !win?.end) return;
    setLoading(true);
    try {
      const r = await api.get("/reports/escort-attendance", { start: win.start, end: win.end });
      setEscortReport(r);
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [win]);
  useEffect(() => {
    if (categoryFilter === "escorts") loadEscortReport();
  }, [categoryFilter, loadEscortReport]);

  useEffect(() => { loadAttendance(); }, [loadAttendance]);

  const exportAttendance = (fmt) => {
    if (!attendance) return;
    // Reuse the /hours/export endpoint — pass every on-screen filter so
    // the CSV/PDF matches exactly what the admin sees (including
    // Institution + Elite, which used to be client-only). The backend
    // applies the same filter logic before rendering the table.
    const params = { start: attendance.start, end: attendance.end, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    if (institutionFilter) params.institution = institutionFilter;
    return downloadBlob("/reports/hours/export", `attendance_${monthIso}.${fmt}`, params);
  };

  const rows = useMemo(() => attendance?.rows || [], [attendance]);
  // Distinct institutions present in the current dataset — feeds the dropdown.
  const institutionOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.institution) set.add(r.institution);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const displayedRows = useMemo(() => {
    let list = rows;
    if (!showEx) list = list.filter((r) => !isExMember({ leaving_date: r.leaving_date }));
    if (categoryFilter === "athlete") {
      list = list.filter((r) => isAthleteLike(r));
    } else if (categoryFilter === "elite") {
      list = list.filter((r) => r.category === "elite");
    } else if (categoryFilter === "rest") {
      list = list.filter((r) => !isAthleteLike(r));
    } else if (categoryFilter === "escorts") {
      list = list.filter((r) => (r.escort_days || 0) > 0);
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
    if (otOnly) {
      // OT filter — any non-zero OT signal (served / applied / approved)
      // this month. Replaces the Comp-off toggle (8 Jul 2026).
      list = list.filter((r) => (r.overtime_hours_served || 0) > 0
                              || (r.overtime_hours_pending || 0) > 0
                              || (r.overtime_hours_approved || 0) > 0);
    }
    const sorted = [...list];
    if (sortBy === "pct_desc") {
      sorted.sort((a, b) => (b.attendance_pct || 0) - (a.attendance_pct || 0)
        || (a.member_name || "").localeCompare(b.member_name || ""));
    } else {
      sorted.sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
    }
    return sorted;
  }, [rows, showEx, categoryFilter, fleetFilter, institutionFilter, otOnly, sortBy, isAthleteLike]);

  const exCount = useMemo(() => rows.filter((r) => isExMember({ leaving_date: r.leaving_date })).length, [rows]);

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

  return (
    <>
      <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="attendance-controls">
        <MonthNav
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrev={onPrevMonth}
          onNext={onNextMonth}
          onToday={onJumpToday}
        />
        {attendance && (
          <div className="text-[11px] text-slate-500 hidden md:block">
            {formatDate(attendance.start)} → {formatDate(attendance.end)}
            &nbsp;·&nbsp; {attendance.rows.length} member{attendance.rows.length === 1 ? "" : "s"}
          </div>
        )}
        <button data-testid="attendance-run" onClick={loadAttendance} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
        </button>
        <div className="flex-1" />
        <button data-testid="export-attendance-csv" onClick={() => exportAttendance("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="export-attendance-pdf" onClick={() => exportAttendance("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-2" data-testid="category-filters">
          {CATEGORY_FILTERS.map((f) => {
            const active = categoryFilter === f.key;
            const count = f.key === "all"
              ? rows.length
              : f.key === "athlete"
                ? rows.filter((r) => isAthleteLike(r)).length
                : f.key === "elite"
                  ? rows.filter((r) => r.category === "elite").length
                  : f.key === "escorts"
                    ? rows.filter((r) => (r.escort_days || 0) > 0).length
                    : rows.filter((r) => !isAthleteLike(r)).length;
            return (
              <button
                key={f.key}
                data-testid={`cat-filter-${f.key}`}
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
              data-testid="fleet-filter"
              value={fleetFilter}
              onChange={(e) => setFleetFilter(e.target.value)}
              className="iu-input !w-40 !py-1 !h-8 text-xs"
            >
              <option value="">All fleets</option>
              {fleetOptions.map((f) => (
                <option key={f} value={f}>
                  {f === "__none__" ? "(No fleet)" : f}
                </option>
              ))}
            </select>
          )}
          {/* Institution dropdown — mirrors the Fleet dropdown but stays
              visible for every category, not just athletes. */}
          {institutionOptions.length > 0 && (
            <select
              data-testid="institution-filter"
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
          {/* OT-only toggle — surfaces rows with any non-zero OT
              signal (served / applied / approved) this month.
              Replaces the previous Comp-off toggle (8 Jul 2026 user
              request "The filter comp off > 0 should be replaced
              with OT > 0"). */}
          <button
            data-testid="ot-only-toggle"
            onClick={() => setOtOnly((v) => !v)}
            className={`iu-chip ${otOnly ? "iu-chip-active" : ""}`}
            title="Show only rows where OT served / applied / approved > 0"
          >
            OT &gt; 0
          </button>
          {exCount > 0 && (
            <ExMemberToggle showEx={showEx} onChange={setShowEx} exCount={exCount} />
          )}
        </div>
        <div className="flex items-center gap-2" data-testid="sort-options">
          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Sort</span>
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.key}
              data-testid={`sort-${s.key}`}
              onClick={() => setSortBy(s.key)}
              className={`iu-chip ${sortBy === s.key ? "iu-chip-active" : ""}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          {/* When the Escorts chip is active we render a completely
              separate slim table sourced from /reports/escort-attendance
              (parent-escorts, not the athletes they accompany). Keeps
              the two data shapes cleanly separated. */}
          {categoryFilter === "escorts" ? (
            <table className="min-w-full text-xs iu-table-compact" data-testid="escort-report-table">
              <thead className="sticky top-0 z-10 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-1.5 px-2 text-left">Escort</th>
                  <th className="py-1.5 px-2 text-left">Institution</th>
                  <th className="py-1.5 px-2 text-left">Mobile</th>
                  <th className="py-1.5 px-2 text-right">Days present</th>
                </tr>
              </thead>
              <tbody>
                {(escortReport?.rows || []).length === 0 && !loading ? (
                  <tr><td colSpan={4} className="py-6 text-center italic text-slate-500">No escort check-ins in this window.</td></tr>
                ) : (escortReport?.rows || []).map((r) => (
                  <tr key={r.escort_id} data-testid={`escort-row-${r.escort_id}`}
                      className="border-t border-slate-100 hover:bg-slate-50/70">
                    <td className="py-1.5 px-2 font-semibold text-slate-800">{r.name}</td>
                    <td className="py-1.5 px-2 text-slate-600">{r.institution || "—"}</td>
                    <td className="py-1.5 px-2 font-mono text-slate-600">{r.mobile || "—"}</td>
                    <td className="py-1.5 px-2 text-right font-bold" title={(r.dates_present || []).join(", ")}>
                      {r.days_present}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
          <table className="min-w-full text-xs iu-table-compact" style={{ minWidth: 1100 }}>
            <thead>
              {/* Grouped header row + sub-header row are BOTH sticky
                  (7 Jul 2026 user-requested). Row 1 pins to top-0,
                  row 2 to top-7 (~28 px = row-1 height with text-[10px]
                  + tight vertical padding). z-20 on both so they
                  overlay the first data row on the initial paint. */}
              <tr className="sticky top-0 z-30 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-500 border-b border-slate-200 shadow-sm">
                <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-100" colSpan={2}>&nbsp;</th>
                <th className="py-1.5 px-2 text-center bg-emerald-50 border-l border-r border-emerald-200 text-emerald-800" colSpan={8}>Attendance</th>
                <th className="py-1.5 px-2 text-center bg-amber-50 border-r border-amber-200 text-amber-800" colSpan={5}>Leave</th>
                <th className="py-1.5 px-2 text-center bg-violet-50 border-r border-violet-200 text-violet-800" colSpan={1}>Overtime</th>
                <th className="py-1.5 px-2 text-center bg-sky-50 border-r border-sky-200 text-sky-800" colSpan={1}>Comp-Off</th>
                {showHours && (
                  <th className="py-1.5 px-2 text-center bg-indigo-50 border-r border-indigo-200 text-indigo-800" colSpan={2}>Hours</th>
                )}
              </tr>
              <tr className="sticky top-7 z-30 bg-slate-50 shadow-sm text-[10px] uppercase tracking-wider font-bold text-slate-500">
                <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-50">Member</th>
                <th className="py-1.5 px-2 text-left hidden md:table-cell sticky left-[140px] z-40 bg-slate-50">Cat</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50 border-l border-emerald-100">Pres</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Lv</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Tour</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Off</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Late</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Half</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Abs</th>
                <th className="py-1.5 px-1.5 text-center bg-emerald-200/50 border-r border-emerald-100 font-extrabold">Tot</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Opening annual leave balance for the year">Open</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Comp-off available YTD (accrued − used). Adds to the leave pool.">COff</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Total = Open + COff (all leave credit available this year)">Total</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Availed = leave taken YTD">Avld</th>
                <th className="py-1.5 px-1.5 text-center bg-amber-200/50 border-r border-amber-100 font-extrabold" title="Closing = Total − Avld">Close</th>
                <th className="py-1.5 px-1.5 text-center bg-violet-200/50 border-r border-violet-100 font-extrabold">OT</th>
                <th className="py-1.5 px-1.5 text-center bg-sky-200/50 border-r border-sky-100 font-extrabold">CO</th>
                {showHours && (
                  <>
                    <th className="py-1.5 px-1.5 text-center bg-indigo-200/50">Tot h</th>
                    <th className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-r border-indigo-100">Avg h</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {displayedRows.map((r, rowIdx) => {
                // Zebra striping (7 Jul 2026 user request "make
                // reports easy read"). Odd rows keep the white
                // background, even rows carry a subtle slate tint;
                // the group column tints (/30 alpha) layer on top
                // so the visual grouping is preserved.
                const isEven = rowIdx % 2 === 1;
                // Higher-contrast zebra (7 Jul 2026 — user asked
                // for stronger banding). slate-200/80 reads
                // clearly against white without overpowering the
                // per-group column tints.
                const rowBg = isEven ? "bg-slate-200" : "bg-white";
                // 7 Jul 2026 (evening): Total now includes Off so
                // weekly-off + in-progress-today land in the sum.
                const attnTotal = (r.days_present || 0) + (r.days_leave || 0) + (r.days_tour || 0) + (r.days_off || 0);
                const otServed = r.overtime_hours_served || 0;
                const n = (v) => (v ? v : "");
                const h = (v) => (v ? `${(+v).toFixed(2).replace(/\.?0+$/, "")}h` : "");
                // Drill-down hover props for a cell — attaches
                // mouse-enter / mouse-leave handlers only when
                // there's actually a date list to show. Empty
                // categories stay plain (no cursor-help, no
                // popover) so admins don't chase phantom hovers.
                const hoverProps = (label, dates) => {
                  const arr = Array.isArray(dates) ? dates : [];
                  if (arr.length === 0) return {};
                  return {
                    onMouseEnter: (e) => showTip(e, label, arr),
                    onMouseLeave: hideTip,
                    className: "cursor-help",
                  };
                };
                // Merge the base cell className with the optional
                // `cursor-help` from `hoverProps`.
                const merge = (base, extra) => {
                  if (!extra || !extra.className) return { className: base, ...(extra || {}) };
                  const { className, ...rest } = extra;
                  return { className: `${base} ${className}`, ...rest };
                };
                return (
                  <tr key={r.member_id} className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`attn-row-${r.member_id}`}>
                    {/* Member + Category are pinned to the left with
                        `position: sticky` so admins keep the row
                        anchor visible when horizontal-scrolling
                        across the 23 columns. Sticky cells inherit
                        the row's zebra tint so the pinned half
                        stays visually aligned with the scrolling
                        half. Double-clicking the name opens the
                        day-by-day timeline modal (7 Jul 2026). */}
                    <td
                      className={`py-1.5 px-2 font-semibold text-slate-800 border-t border-slate-100 sticky left-0 z-10 ${rowBg} group-hover:bg-sky-50 cursor-pointer`}
                      onDoubleClick={() => setTimelineMember(r)}
                      title="Double-click for day-by-day timeline"
                      data-testid={`attn-name-${r.member_id}`}
                    >
                      {r.member_name}
                      <ExMemberChip member={{ id: r.member_id, leaving_date: r.leaving_date }} className="ml-1.5 align-middle" />
                      <div className="text-[10px] text-slate-400 leading-tight">
                        {r.rank || ""}
                        {r.attendance_pct !== undefined && (
                          <span className={`font-bold text-slate-800 ${r.rank ? "ml-1.5" : ""}`}>{r.attendance_pct}%</span>
                        )}
                      </div>
                    </td>
                    <td className={`py-1.5 px-2 hidden md:table-cell text-slate-600 border-t border-slate-100 sticky left-[140px] z-10 ${rowBg} group-hover:bg-sky-50`}>{categoryLabel(r.category)}</td>
                    {/* Attendance group — double-clicking ANY of these 8
                        cells opens the date-wise Attendance Ledger for
                        this member across the current reporting range
                        (04 Feb 2026 user request). */}
                    {(() => {
                      const openAttn = () => setAttnLedger({ member_id: r.member_id, member_name: r.member_name });
                      const attnCell = "cursor-pointer hover:bg-emerald-200/70";
                      return (
                        <>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-l border-t border-emerald-100 font-semibold text-emerald-700 ${attnCell}`, hoverProps("Present · double-click for daily ledger", r.dates_present))} data-testid={`days-present-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_present)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-amber-700 ${attnCell}`, hoverProps("Leave · double-click for daily ledger", r.dates_leave))} data-testid={`days-leave-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_leave)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-orange-700 ${attnCell}`, hoverProps("Tour · double-click for daily ledger", r.dates_tour))} data-testid={`days-tour-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_tour)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-slate-500 ${attnCell}`, hoverProps("Off · double-click for daily ledger", r.dates_off))} data-testid={`days-off-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_off)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-amber-600 ${attnCell}`, hoverProps("Late · double-click for daily ledger", r.dates_late))} data-testid={`late-days-${r.member_id}`} onDoubleClick={openAttn}>{n(r.late_days)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 ${attnCell}`, hoverProps("Half-day · double-click for daily ledger", r.dates_half_day))} data-testid={`half-days-${r.member_id}`} onDoubleClick={openAttn}>{n(r.half_days)}</td>
                    <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 font-semibold ${(r.days_absent || 0) > 0 ? "text-red-600" : "text-slate-400"} ${attnCell}`, hoverProps("Absent · double-click for daily ledger", r.dates_absent))} data-testid={`days-absent-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_absent)}</td>
                    <td className={`py-1.5 px-1.5 text-center bg-emerald-200/50 border-r border-t border-emerald-100 font-extrabold text-slate-900 ${attnCell}`} data-testid={`days-total-${r.member_id}`} onDoubleClick={openAttn} title="Double-click for daily ledger">{n(attnTotal)}</td>
                        </>
                      );
                    })()}
                    {/* Leave group — 5 columns (8 Jul 2026 user
                        request: Open · COff · Total · Avld · Close).
                        COff is comp-off available YTD, pulled from
                        /leave-balances and merged client-side; it
                        adds to the leave pool. Athletes fall through
                        to 0 for all fields (Breaks workflow).
                        Double-clicking Open / Total / Avld / Close
                        opens the year-wide Leave ledger (applied /
                        availed / rejected). COff opens the comp-off
                        ledger instead — it's conceptually a
                        different pool. */}
                    {(() => {
                      const open = r.leave_balance_opening || 0;
                      const coff = compOffMap[r.member_id] || 0;
                      const total = open + coff;
                      const avld = r.leave_balance_taken_ytd || 0;
                      const close = Math.round((total - avld) * 10) / 10;
                      const hasBalance = open > 0 || coff > 0 || avld > 0;
                      const fmt = (v) => (hasBalance ? String(v) : "");
                      const openLv = () => setLvLedger({ member_id: r.member_id, member_name: r.member_name });
                      const openCo = () => setCoLedger({ member_id: r.member_id, member_name: r.member_name });
                      const lvCell = "py-1.5 px-1.5 text-center bg-amber-200/50 border-t border-amber-100 cursor-pointer hover:bg-amber-200/50";
                      return (
                        <>
                          <td className={lvCell} data-testid={`leave-open-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(open)}</td>
                          <td className={`${lvCell} text-sky-700`} data-testid={`leave-coff-${r.member_id}`} onDoubleClick={openCo} title="Double-click for comp-off ledger">{coff > 0 ? String(coff) : ""}</td>
                          <td className={`${lvCell} font-semibold`} data-testid={`leave-total-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(total)}</td>
                          <td className={lvCell} data-testid={`leave-avld-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(avld)}</td>
                          <td className={`py-1.5 px-1.5 text-center bg-amber-200/50 border-r border-t border-amber-100 font-extrabold cursor-pointer hover:bg-amber-200/50 ${close < 0 ? "text-red-600" : "text-emerald-700"}`} data-testid={`leave-close-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(close)}</td>
                        </>
                      );
                    })()}
                    {/* Overtime group — comes BEFORE Comp-off (07 Jul
                        2026 user request "shift OT one left"). Double-
                        clicking any OT cell opens the year's OT ledger
                        for this member. Applied + Approved columns
                        removed 04 Feb 2026 per user request; the OT
                        Ledger (double-click) still shows the full
                        applied/approved breakdown per session. */}
                    <td {...merge("py-1.5 px-1.5 text-center bg-violet-200/50 border-r border-t border-violet-100 font-extrabold cursor-pointer hover:bg-violet-200/50", hoverProps("OT earned by the system · double-click for OT ledger", r.dates_overtime_served))} data-testid={`ot-served-${r.member_id}`} onDoubleClick={() => setOtLedger({ member_id: r.member_id, member_name: r.member_name })}>{h(otServed)}</td>
                    {/* Comp-off group — double-clicking any cell
                        opens the year's comp-off ledger (Earned /
                        Applied / Approved with DOW). Hover tooltip
                        still shows the month's dates inline. Applied
                        + Approved removed 04 Feb 2026; the ledger
                        drill-down still carries the full applied/
                        approved detail. */}
                    <td {...merge("py-1.5 px-1.5 text-center bg-sky-200/50 border-r border-t border-sky-100 font-extrabold cursor-pointer hover:bg-sky-200/50", hoverProps("Comp-off earned · double-click for ledger", r.dates_comp_off_earned))} data-testid={`comp-off-earned-${r.member_id}`} onDoubleClick={() => setCoLedger({ member_id: r.member_id, member_name: r.member_name })}>{n(r.comp_off_earned)}</td>
                    {/* Hours group — super-admin only. Hidden from
                        regular admins per 04 Feb 2026 privacy request. */}
                    {showHours && (
                      <>
                        <td className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-t border-indigo-100">{r.total_hours ? `${r.total_hours}h` : ""}</td>
                        <td className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-r border-t border-indigo-100 text-slate-600">{r.avg_hours_per_day ? `${r.avg_hours_per_day}h` : ""}</td>
                      </>
                    )}
                  </tr>
                );
              })}
              {!loading && displayedRows.length === 0 && (
                <tr><td colSpan={showHours ? 19 : 17} className="text-center py-10 text-slate-500">No data.</td></tr>
              )}
            </tbody>
          </table>
          )}
        </div>
      </div>

      {/* OT-ledger drill-down — opens on double-click of any OT cell.
          Month-scoped (15 Feb 2026 user request). */}
      <OTLedgerModal
        open={!!otLedger}
        onClose={() => setOtLedger(null)}
        memberId={otLedger?.member_id}
        memberName={otLedger?.member_name}
        month={monthIso}
      />

      {/* Comp-off ledger drill-down — opens on double-click of any
          Comp-off cell (Earned / Applied / Approved). */}
      <CompOffLedgerModal
        open={!!coLedger}
        onClose={() => setCoLedger(null)}
        memberId={coLedger?.member_id}
        memberName={coLedger?.member_name}
        month={monthIso}
      />

      {/* Leave ledger drill-down — opens on double-click of any Leave
          section cell (Open / Total / Avld / Close). */}
      <LeaveLedgerModal
        open={!!lvLedger}
        onClose={() => setLvLedger(null)}
        memberId={lvLedger?.member_id}
        memberName={lvLedger?.member_name}
        month={monthIso}
      />

      {/* Attendance ledger drill-down — opens on double-click of any
          Attendance cell (Pres / Lv / Tour / Off / Late / Half / Abs /
          Tot). Scoped to the current report's start-end window. */}
      <AttendanceLedgerModal
        open={!!attnLedger}
        onClose={() => setAttnLedger(null)}
        memberId={attnLedger?.member_id}
        memberName={attnLedger?.member_name}
        start={attendance?.start}
        end={attendance?.end}
      />

      {tip && ReactDOM.createPortal(
        <DrillDownBubble tip={tip} />,
        document.body
      )}

      {timelineMember && attendance && (
        <MemberTimelineModal
          memberId={timelineMember.member_id}
          start={attendance.start}
          end={attendance.end}
          onClose={() => setTimelineMember(null)}
        />
      )}
    </>
  );
}
