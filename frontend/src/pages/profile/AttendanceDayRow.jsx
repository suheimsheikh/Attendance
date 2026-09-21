import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { CELL_STYLE, fmtOt } from "../admin/calendar-grid/gridHelpers";
import { AttendanceDayDetails, attendanceTime } from "./AttendanceDayDetails";

export const REGISTER_COLUMNS = "lg:grid-cols-[80px_1.5fr_1fr_1.2fr_.8fr_1fr_.8fr_1fr_32px]";
const DAR = { filed: "Filed", missing: "Missing", pending: "Pending", not_applicable: "—" };

export const AttendanceDayRow = ({ day, timezone, index }) => {
  const [expanded, setExpanded] = useState(false);
  const sessions = day.sessions;
  const style = CELL_STYLE[day.code];
  const status = style?.title || (day.is_future ? "Upcoming" : day.is_today ? "Not checked in" : "No record");
  const missingOut = sessions.some(s => s.missing_checkout || (!s.check_out_at && !day.is_today));
  const isOpen = sessions.some(s => !s.check_out_at && !s.missing_checkout);
  const checkIn = sessions.find(s => s.check_in_at)?.check_in_at;
  const checkOut = sessions.map(s => s.check_out_at).filter(Boolean).sort().pop();
  const hours = sessions.length && sessions.every(s => s.hours !== null && !s.missing_checkout)
    ? `${Math.round(sessions.reduce((n, s) => n + s.hours, 0) * 100) / 100}h` : "—";
  const late = Math.max(0, ...sessions.map(s => s.late_minutes));
  const early = Math.max(0, ...sessions.map(s => s.early_out_minutes));
  const ot = sessions.reduce((n, s) => n + s.overtime_total_min, 0);
  const date = new Date(`${day.date}T12:00:00Z`);
  const detail = !!(sessions.length || day.leaves.length || day.meta.break_name || day.manual_override);
  const notes = [day.meta.break_name, ...new Set(sessions.map(s => s.site_name).filter(Boolean)),
    ...day.leaves.map(l => `${l.type.replace(/_/g, " ")}${l.half_day ? ` (${l.half_day})` : ""} · ${l.status}${l.reason ? `: ${l.reason}` : ""}`)].filter(Boolean);
  const cell = (key, label, value, className = "") => <div className={`min-w-0 break-words ${className}`} data-testid={`profile-day-${key}-${day.date}`}>
    <span className="lg:hidden block text-[10px] text-slate-500 mb-1">{label}</span>{value}
  </div>;
  return (
    <div data-testid={`profile-day-${day.date}`} className={`px-3 py-3 border-b border-slate-200 ${index % 2 ? "bg-white" : "bg-slate-200"} ${day.is_today ? "border-l-4 border-l-sky-500" : ""}`}>
      <div className={`grid grid-cols-2 sm:grid-cols-4 ${REGISTER_COLUMNS} gap-x-3 gap-y-3 items-center text-xs tabular-nums`}>
        {cell("date", "Date", <><b>{date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}</b><span className="block text-slate-500 mt-0.5">{date.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}{day.is_today ? " · Today" : ""}</span></>)}
        {cell("status", "Status", <span className={`inline-block px-2 py-1 rounded font-semibold ${style ? `${style.bg} ${style.text}` : "bg-slate-100 text-slate-500"}`}>
          {day.code ? `${day.code} · ` : ""}{status}</span>)}
        {cell("in", "Time in", attendanceTime(checkIn, timezone))}
        {cell("out", "Time out", missingOut ? "Missing check-out" : isOpen ? "Checked in" : attendanceTime(checkOut, timezone), missingOut ? "text-rose-700 font-semibold" : "")}
        {cell("hours", "Hours", hours)}
        {cell("timing", "Late / early", <>{late > 0 && <span className="block text-orange-700">LT {late}m</span>}{early > 0 && <span className="block text-rose-700">EO {early}m</span>}{!late && !early ? "—" : ""}</>)}
        {cell("ot", "Overtime", fmtOt(ot) || "—")}
        {cell("dar", "DAR", DAR[day.dar_status], day.dar_status === "missing" ? "text-rose-700 font-semibold" : "")}
        {detail ? <button type="button" data-testid={`profile-day-expand-${day.date}`} aria-expanded={expanded}
          aria-controls={`profile-day-details-${day.date}`} aria-label={`${expanded ? "Hide" : "Show"} details for ${day.date}`}
          title={`${expanded ? "Hide" : "Show"} day details`} onClick={() => setExpanded(v => !v)}
          className="w-8 h-8 inline-flex items-center justify-center border border-slate-300 rounded hover:bg-sky-100 transition-colors">
          {expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}</button> : <span/>}
      </div>
      {notes.length > 0 && <p className="mt-2 text-xs text-slate-600 break-words" data-testid={`profile-day-notes-${day.date}`}>{notes.join(" · ")}</p>}
      {expanded && <AttendanceDayDetails day={day} timezone={timezone}/>}
    </div>
  );
};