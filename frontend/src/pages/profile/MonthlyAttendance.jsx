import React, { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { api } from "../../api";
import { fmtOt } from "../admin/calendar-grid/gridHelpers";
import { AttendanceDayRow, REGISTER_COLUMNS } from "./AttendanceDayRow";

const TOTALS = [["present", "Present"], ["absent", "Absent"], ["leave", "Leave incl. CO / LOP"],
  ["lop", "LOP"], ["tour", "Tour"], ["late", "Late"], ["early_out", "Early out"], ["ot_minutes", "Overtime"], ["dar_missed", "DAR missed"]];

export const MonthlyAttendance = ({ memberId, month, onMonthChange }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setData(null);
    const path = memberId ? `/admin/members/${memberId}/attendance-month` : "/me/attendance-month";
    api.get(path, month ? { month } : undefined).then(result => {
      if (!cancelled) setData(result);
    }).catch(err => { if (!cancelled) setError(err.message || "Could not load attendance."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [memberId, month, retry]);
  const shownMonth = month || data?.month || "";
  const move = offset => {
    const [year, mon] = shownMonth.split("-").map(Number);
    const absoluteMonth = year * 12 + mon - 1 + offset;
    onMonthChange(`${String(Math.floor(absoluteMonth / 12)).padStart(4, "0")}-${String(absoluteMonth % 12 + 1).padStart(2, "0")}`);
  };
  return (
    <section data-testid="profile-monthly-attendance" className="min-w-0 border-t border-slate-300 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="font-bold text-base md:text-lg flex items-center gap-2"><CalendarDays size={18}/> Monthly attendance</h2>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="profile-month-controls">
          <button type="button" className="iu-btn-secondary !px-2" disabled={!shownMonth || shownMonth === "0001-01"} onClick={() => move(-1)}
            title="Previous month" aria-label="Previous month" data-testid="profile-month-previous"><ChevronLeft size={16}/></button>
          <input type="month" min="0001-01" max="9998-12" value={shownMonth} aria-label="Attendance month" data-testid="profile-attendance-month"
            className="iu-input !w-40 min-w-0" onChange={e => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) onMonthChange(e.target.value); }}/>
          <button type="button" className="iu-btn-secondary !px-2" disabled={!shownMonth || shownMonth === "9998-12"} onClick={() => move(1)}
            title="Next month" aria-label="Next month" data-testid="profile-month-next"><ChevronRight size={16}/></button>
          <button type="button" className="iu-btn-secondary !px-2" data-testid="profile-month-current" onClick={() => { if (month) onMonthChange(""); else setRetry(n => n + 1); }}>Current month</button>
        </div>
      </div>
      {loading ? <div className="flex justify-center gap-2 p-8 text-sm text-slate-500" role="status" data-testid="profile-attendance-loading"><Loader2 className="animate-spin" size={18}/> Loading attendance…</div>
        : error ? <div role="alert" data-testid="profile-attendance-error" className="p-4 bg-rose-50 text-rose-800 flex flex-wrap items-center gap-3">
          {error}<button data-testid="profile-attendance-retry" className="iu-btn-secondary" onClick={() => setRetry(n => n + 1)}><RefreshCw size={14}/> Retry</button>
        </div> : data && <>
          <p className="text-xs text-slate-500 mb-3" data-testid="profile-attendance-period">
            {data.member_name} · {new Date(`${data.month}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}
            {` · ${data.days.length} days · ${data.timezone} · Schedule ${data.work_start}–${data.work_end}`}
          </p>
          <dl className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-x-3 gap-y-4 mb-5" data-testid="profile-month-totals">
            {TOTALS.map(([key, label]) => <div key={key} data-testid={`profile-month-total-${key}`}>
              <dt className="text-[10px] text-slate-500">{label}</dt>
              <dd className="text-lg font-bold tabular-nums">{key === "ot_minutes" ? fmtOt(data.totals[key]) || "0m" : data.totals[key]}</dd>
            </div>)}
          </dl>
          <div className="border border-slate-200 rounded-lg overflow-hidden" data-testid="profile-attendance-register">
            <div className={`hidden lg:grid ${REGISTER_COLUMNS} gap-x-3 px-3 py-2 bg-slate-100 text-[10px] font-semibold text-slate-600 border-b border-slate-300`}>
              {["Date", "Status", "Time in", "Time out", "Hours", "Late / early", "Overtime", "DAR", ""].map((label, i) => <span key={i}>{label}</span>)}
            </div>
            {data.days.map((day, index) => <AttendanceDayRow key={`${data.member_id}-${day.date}`} day={day} index={index} timezone={data.timezone}/>)}
          </div>
        </>}
    </section>
  );
};