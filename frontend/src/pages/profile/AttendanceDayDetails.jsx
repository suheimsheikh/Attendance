import React from "react";
import { formatDate } from "../../utils";

export const attendanceTime = (iso, timezone) => iso
  ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone }) : "—";

const LEAVE_NAMES = { leave: "Leave", tour: "Tour", posting: "Posting", comp_off: "Comp-off", late_coming: "Late-coming permission" };

export const AttendanceDayDetails = ({ day, timezone }) => (
  <div id={`profile-day-details-${day.date}`} data-testid={`profile-day-details-${day.date}`}
    className="border-t border-slate-300 mt-2 pt-3 space-y-3 text-xs text-slate-700 break-words">
    {day.manual_override && <p data-testid={`profile-day-override-${day.date}`} className="font-semibold">Manual grid override: {day.code}</p>}
    {day.meta.break_name && <p data-testid={`profile-day-break-${day.date}`}>
      <b>Break: {day.meta.break_name}</b> · {day.meta.range}
      {day.meta.applied_by && <> · Applied by {day.meta.applied_by}</>}
    </p>}
    {day.meta.balance_split && <p data-testid={`profile-day-balance-split-${day.date}`}>{day.meta.balance_split}</p>}
    {day.leaves.map(leave => <div key={leave.id} data-testid={`profile-day-leave-${day.date}-${leave.id}`} className="space-y-1">
      <p><b>{LEAVE_NAMES[leave.type] || leave.type}</b> · {leave.status}{leave.converted_to_lop ? " → LOP" : ""}
        {leave.half_day && <> · Half day ({leave.half_day})</>}</p>
      <p>{formatDate(leave.start_date)} – {formatDate(leave.end_date)}</p>
      {leave.reason && <p>{leave.reason}</p>}
      {leave.decided_by && <p>Approved by {leave.decided_by}{leave.decided_at ? ` · ${formatDate(leave.decided_at)}` : ""}</p>}
    </div>)}
    {day.sessions.map((session, index) => <div key={session.id} data-testid={`profile-day-session-${session.id}`} className="space-y-1">
      <p className="font-semibold">{day.sessions.length > 1 ? `Session ${index + 1} · ` : ""}
        {attendanceTime(session.check_in_at, timezone)} – {session.missing_checkout ? "Missing check-out" : session.check_out_at ? attendanceTime(session.check_out_at, timezone) : day.is_today ? "Still checked in" : "Missing check-out"}
        {session.hours !== null && !session.missing_checkout && <> · {session.hours}h</>}
      </p>
      <p>{[session.site_name, session.method, session.out_of_geofence ? "Off-site" : null].filter(Boolean).join(" · ") || "Location not recorded"}</p>
      {session.needs_correction && <p className="text-rose-700 font-semibold">Attendance correction needed</p>}
      {session.geo_reason && <p>Off-site reason: {session.geo_reason}</p>}
      {session.late_minutes > 0 && <p>Late by {session.late_minutes} min</p>}
      {session.early_out_minutes > 0 && <p>Early out: {session.early_out_minutes} min{session.early_out_reason ? ` · ${session.early_out_reason}` : ""}</p>}
      {session.overtime_total_min > 0 && <p>Overtime: {session.overtime_total_min} min{session.overtime_reason ? ` · ${session.overtime_reason}` : ""}</p>}
      {session.excursions.map((exit, i) => <p key={i} data-testid={`profile-session-excursion-${session.id}-${i}`}>
        Step out: {attendanceTime(exit.out_at, timezone)} – {exit.in_at ? attendanceTime(exit.in_at, timezone) : "Return not recorded"}
        {exit.reason ? ` · ${exit.reason}` : ""}{exit.expected_return ? ` · Expected ${attendanceTime(exit.expected_return, timezone)}` : ""}
      </p>)}
    </div>)}
  </div>
);