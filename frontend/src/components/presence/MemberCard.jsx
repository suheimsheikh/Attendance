import React, { useState } from "react";
import { AlertTriangle, Clock, Coffee, ChevronDown, ChevronRight, Repeat, MapPin } from "lucide-react";
import Avatar from "../Avatar";
import PhotoZoom from "../PhotoZoom";
import ParentContact from "../ParentContact";
import NotifyParentsButton from "../NotifyParentsButton";
import { categoryLabel } from "../../utils";
import { GeoLine } from "./GeoLine";
import { SessionTimeline } from "./SessionTimeline";
import { ExpectedReturnPill } from "./ExpectedReturnPill";

export function MemberCard({ m, accent, columnKey, adminContacts, coachMobile, onSent, onDoubleClick, hidden, expanded, onToggleExpand, density = "detailed" }) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const compact = density === "compact";
  const lateBg = m.late ? "bg-red-50 hover:bg-red-100" : "hover:bg-slate-50";
  const notifyDueType = m.notify_due?.not_arrived
    ? "not_arrived"
    : (m.notify_due?.late ? "late" : null);
  const notifiedType = m.notified_today?.not_arrived
    ? "not_arrived"
    : (m.notified_today?.late ? "late" : null);
  const handleDouble = !hidden && onDoubleClick ? () => onDoubleClick(m.id) : undefined;
  // When `hidden`, the row reserves the same space as the real card in the
  // paired column at this index — guarantees pixel-aligned rows across the
  // Stepped Out / Checked Out pair without measurement hacks.
  const hiddenStyle = hidden ? { visibility: "hidden", pointerEvents: "none" } : undefined;
  // Timeline only meaningful when there's a session to show — suppress the
  // chevron for statuses like on_leave, on_tour, absent, not_due.
  const hasTimeline = !hidden && (m.check_in_at || (m.excursions && m.excursions.length > 0));
  return (
    <>
    <div
      className={`${compact ? "px-3 py-1.5" : "px-3 py-2.5"} flex gap-2.5 items-start transition ${hidden ? "" : lateBg} ${!hidden && onDoubleClick ? "cursor-pointer select-none" : ""}`}
      data-testid={hidden ? `presence-blank-${columnKey}-${m.id}` : `presence-row-${m.id}`}
      onDoubleClick={handleDouble}
      title={!hidden && onDoubleClick ? (columnKey === "on_campus" ? "Double-click to remove from On Campus" : "Double-click to edit member") : undefined}
      style={hiddenStyle}
      aria-hidden={hidden ? true : undefined}
    >
      <button
        type="button"
        onClick={(e) => { if (!hidden) { e.stopPropagation(); setZoomOpen(true); } }}
        className="shrink-0 bg-transparent border-0 p-0 cursor-zoom-in disabled:cursor-default"
        disabled={hidden}
        title={hidden ? undefined : "Click to zoom photo"}
        data-testid={hidden ? undefined : `presence-photo-${m.id}`}
      >
        <Avatar name={m.full_name} photo={m.photo} size={34} ring={columnKey === "on_campus" ? accent : null} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <div className={`text-[13px] font-semibold leading-tight truncate flex-1 ${m.late ? "text-red-700" : "text-slate-900"}`}>{m.full_name}</div>
          <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
          {hasTimeline && onToggleExpand && (
            <button
              type="button"
              data-testid={`presence-expand-${m.id}`}
              onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
              className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition ${expanded ? "bg-slate-200 text-slate-700" : "text-slate-400 hover:bg-slate-100"}`}
              title={expanded ? "Hide session timeline" : "Show full check-in / check-out timeline"}
              aria-label="Toggle timeline"
            >
              {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
            </button>
          )}
        </div>
        <div className={`text-[11px] text-slate-500 leading-tight mt-0.5 flex items-center gap-1.5 flex-wrap ${compact ? "hidden" : ""}`}>
          <span className="truncate">{m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}</span>
          {m.institution && (
            <span
              title={`Institution: ${m.institution}`}
              data-testid={`presence-institution-chip-${m.id}`}
              className="inline-flex items-center px-1 h-4 rounded text-[9px] font-bold bg-sky-100 text-sky-700 max-w-[110px] truncate leading-none"
            >
              {m.institution}
            </span>
          )}
          {m.site_name && (
            <span
              title={`Checked in at: ${m.site_name}`}
              data-testid={`presence-site-chip-${m.id}`}
              className="inline-flex items-center gap-0.5 px-1 h-4 rounded text-[9px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 max-w-[130px] truncate leading-none"
            >
              <MapPin size={8} className="shrink-0" />{m.site_name}
            </span>
          )}
        </div>
        {m.detail && !compact && (
          <div className="text-[11px] text-slate-500 truncate mt-0.5">{m.detail}</div>
        )}
        <div className={`flex flex-wrap gap-1 mt-1 ${compact ? "hidden" : ""}`}>
          {columnKey === "temp_out" && (
            <ExpectedReturnPill
              expectedReturnTime={m.expected_return_time}
              expectedReturnIso={m.expected_return}
              overdueMinutes={m.overdue_minutes}
              testId={`presence-due-${m.id}`}
            />
          )}
          {m.excursion_count > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200 text-[10px] font-bold"
              data-testid={`excursion-count-${m.id}`}
              title={`${m.excursion_count} excursion${m.excursion_count === 1 ? "" : "s"} today (stepped out and returned)`}
            >
              <Coffee size={9}/> {m.excursion_count}×
            </span>
          )}
          {m.sessions_today_count > 1 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold"
              data-testid={`sessions-today-${m.id}`}
              title={`${m.sessions_today_count} separate sessions today — split shift, or an accidental double check-in worth a glance.`}
            >
              <Repeat size={9}/> {m.sessions_today_count} sessions
            </span>
          )}
          {m.days_remaining != null && m.days_remaining > 0 && (m.status === "on_leave" || m.status === "on_tour") && (
            <span
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${m.status === "on_tour" ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800"}`}
              data-testid={`days-remaining-${m.id}`}
              title={`Returns after ${m.days_remaining} day${m.days_remaining === 1 ? "" : "s"}`}
            >
              {m.days_remaining}d more
            </span>
          )}
          {m.leave_kind === "posting" && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-bold"
              data-testid={`posting-chip-${m.id}`}
              title="On posting / deputation to another academy"
            >
              POSTED
            </span>
          )}
          {m.half_day && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-bold"
              data-testid={`halfday-chip-${m.id}`}
              title={`Half-day leave (${m.half_day === "FN" ? "forenoon" : "postnoon"})`}
            >
              HALF · {m.half_day}
            </span>
          )}
          {m.status === "absent" && m.days_absent_streak > 1 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold"
              data-testid={`days-absent-${m.id}`}
              title={`Absent for ${m.days_absent_streak} consecutive days${m.days_absent_streak >= 30 ? " (max lookback)" : ""}`}
            >
              {m.days_absent_streak}{m.days_absent_streak >= 30 ? "+" : ""}d absent
            </span>
          )}
          {m.flagged && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
              <AlertTriangle size={9} /> Off-site
            </span>
          )}
          {m.late && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold" data-testid={`late-chip-${m.id}`}>
              <Clock size={9} /> Late
            </span>
          )}
          {m.overdue_minutes > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold" data-testid={`overdue-chip-${m.id}`}>
              <AlertTriangle size={9} /> Overdue {m.overdue_minutes}m
            </span>
          )}
          {notifyDueType && (
            <NotifyParentsButton
              member={m}
              type={notifyDueType}
              adminContacts={adminContacts}
              coachMobile={coachMobile}
              onSent={onSent}
            />
          )}
          {!notifyDueType && notifiedType && (
            <NotifyParentsButton member={m} type={notifiedType} notified onSent={onSent} />
          )}
        </div>
        {!compact && <GeoLine geoIn={m.geo_in} geoOut={m.geo_out} status={m.status} />}
      </div>
    </div>
    {expanded && hasTimeline && <SessionTimeline m={m} />}
    {zoomOpen && (
      <PhotoZoom
        name={m.full_name}
        photo={m.photo}
        subtitle={m.rank ? `${m.rank} · ${categoryLabel(m.category)}` : categoryLabel(m.category)}
        onClose={() => setZoomOpen(false)}
      />
    )}
    </>
  );
}
