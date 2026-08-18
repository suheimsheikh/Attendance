import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth";
import { api } from "../../api";
import CalendarGridTab from "./CalendarGridTab";
import AttendanceTab from "./reports/AttendanceTab";
import DailyTab from "./reports/DailyTab";
import MonthNav from "./reports/MonthNav";
import { VALID_TABS } from "./reports/constants";
import { pad2, monthWindow } from "./reports/utils";

/**
 * Reports page — 3 tabs: Calendar Grid, Attendance (big monthly
 * table), Daily leave/tour list. Since Feb 2026 each tab lives in its
 * own file under `./reports/`; this component only orchestrates the
 * shared month-navigator state and the URL-driven tab switch.
 */
export default function Reports() {
  // Month-navigator state (30 Jun 2026): admins think in months, not
  // arbitrary date ranges. Shared between Calendar + Attendance tabs
  // so switching tabs preserves the picked month.
  const _now = new Date();
  const [year, setYear] = useState(_now.getFullYear());
  const [monthIdx, setMonthIdx] = useState(_now.getMonth());
  const win = useMemo(() => monthWindow(year, monthIdx), [year, monthIdx]);
  const { isCurrent, label: monthLabel } = win;
  const monthIso = `${year}-${pad2(monthIdx + 1)}`;
  const stepMonth = (delta) => {
    let m = monthIdx + delta, y = year;
    while (m < 0)  { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    setYear(y); setMonthIdx(m);
  };
  const jumpToday = () => { setYear(_now.getFullYear()); setMonthIdx(_now.getMonth()); };

  // Tab is URL-driven so /admin/reports?tab=daily works, and legacy
  // links (e.g. /admin/payroll → /admin/reports?tab=payroll) route to
  // the merged Attendance tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  // Legacy aliases: `payroll` and `hours` both fold into the merged
  // "attendance" tab (7 Jul 2026 — user-requested collapse of the two).
  const normaliseTab = (t) => (t === "payroll" || t === "hours") ? "attendance" : t;
  const initial = VALID_TABS.has(normaliseTab(urlTab)) ? normaliseTab(urlTab) : "calendar";
  const [tab, setTabState] = useState(initial);
  const setTab = (t) => {
    setTabState(t);
    const next = new URLSearchParams(searchParams);
    // Calendar is the fallback in `initial` when no ?tab is set, so
    // clicking Calendar strips the param (idempotent) while every
    // other tab writes ?tab=<t> — this way a page refresh always
    // returns the user to the tab they last clicked.
    if (t === "calendar") next.delete("tab"); else next.set("tab", t);
    setSearchParams(next, { replace: true });
  };
  useEffect(() => {
    const n = normaliseTab(urlTab);
    if (VALID_TABS.has(n) && n !== tab) setTabState(n);
  }, [urlTab, tab]);

  // Super-admin gating — the Hours group (Total Hours + Avg Hours) is
  // privacy-sensitive and only the top-of-org account should see it.
  // Flag is stamped on /auth/me from an env whitelist of phone numbers
  // (SUPER_ADMIN_PHONES). 04 Feb 2026 user request.
  const { user: currentUser } = useAuth();
  const showHours = !!currentUser?.is_super_admin;

  // Athlete-like category keys — driven by categories master so Elite
  // (and any future admin-added athlete-like category) is bucketed with
  // Athletes, not Staff & Coaches. Fixes 15 Jul 2026 user report
  // "In the staff and coaches filter a lot of athletes appear".
  // Shared between Attendance table and Calendar Grid so the two views
  // classify the same rows the same way.
  const [athleteLikeKeys, setAthleteLikeKeys] = useState(() => new Set(["athlete", "elite"]));
  useEffect(() => {
    api.get("/masters/categories").then((cats) => {
      const rows = Array.isArray(cats) ? cats : (cats?.items || []);
      const keys = rows.filter((c) => c.is_athlete_like).map((c) => c.key);
      if (keys.length) setAthleteLikeKeys(new Set(keys));
    }).catch(() => { /* fall back to defaults */ });
  }, []);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">The Grid</h1>
        <p className="text-slate-500 text-sm mt-1">Calendar view, attendance summaries and daily leave/tour lists — all in one place.</p>
      </header>

      <div className="flex gap-2 mb-4">
        <button data-testid="tab-calendar" onClick={() => setTab("calendar")} title="31-day per-member grid: presence, leaves, offs, hours and payroll columns" className={`iu-chip ${tab === "calendar" ? "iu-chip-active" : ""}`}>Calendar Grid</button>
        <button data-testid="tab-attendance" onClick={() => setTab("attendance")} title="Date-range attendance summary with drill-down and CSV export" className={`iu-chip ${tab === "attendance" ? "iu-chip-active" : ""}`}>Attendance</button>
        <button data-testid="tab-daily" onClick={() => setTab("daily")} title="Who was on leave or tour on a given day" className={`iu-chip ${tab === "daily" ? "iu-chip-active" : ""}`}>Daily Leave/Tour</button>
      </div>

      {tab === "attendance" && (
        <AttendanceTab
          monthIso={monthIso}
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrevMonth={() => stepMonth(-1)}
          onNextMonth={() => stepMonth(1)}
          onJumpToday={jumpToday}
          win={win}
          showHours={showHours}
          athleteLikeKeys={athleteLikeKeys}
        />
      )}

      {tab === "daily" && <DailyTab />}

      {tab === "calendar" && (
        <CalendarGridTab
          monthIso={monthIso}
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrevMonth={() => stepMonth(-1)}
          onNextMonth={() => stepMonth(1)}
          onJumpToday={jumpToday}
          MonthNav={MonthNav}
          athleteLikeKeys={athleteLikeKeys}
        />
      )}
    </div>
  );
}
