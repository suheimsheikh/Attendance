import React from "react";
import { Clock, RefreshCw, UserPlus, UserX, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate } from "../../utils";

/**
 * PresenceHeader — title + date picker + late toggle + absent chip + guest
 * CTA + members count + refresh. Extracted from Presence.jsx to keep the
 * parent focused on data orchestration.
 *
 * All state is owned by the parent; this component is pure presentation
 * driven by props.
 */
export function PresenceHeader({
  data,
  isHistorical,
  today,
  viewDate,
  shiftIso,
  onViewDateChange,
  lateOnly,
  onToggleLateOnly,
  lateCount,
  absentCount,
  canManageGuests,
  onAddGuest,
  activeGuestCount,
  totalMembers,
  onRefresh,
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" data-testid="presence-title">Presence Board</h1>
        <p className="text-slate-500 mt-1 text-sm">
          {data ? formatDate(data.date) : "Live campus roster"}
          {isHistorical && <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wider">Read-only history</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center gap-1 bg-white border-2 border-slate-300 px-1.5 h-11 rounded-xl text-sm font-bold text-slate-800 shadow-sm">
          <button
            type="button"
            data-testid="presence-date-prev"
            onClick={() => {
              const cur = viewDate || today;
              const next = shiftIso(cur, -1);
              onViewDateChange(next === today ? "" : next);
            }}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 transition"
            title="Previous day"
            aria-label="Previous day"
          >
            <ChevronLeft size={18} strokeWidth={2.5} />
          </button>
          <input
            type="date"
            data-testid="presence-date-picker"
            value={viewDate || today}
            max={today}
            onChange={(e) => onViewDateChange(e.target.value === today ? "" : e.target.value)}
            className="bg-transparent border-0 outline-none text-sm font-bold w-[130px] text-center"
            aria-label="View presence for a specific date"
          />
          <button
            type="button"
            data-testid="presence-date-next"
            onClick={() => {
              const cur = viewDate || today;
              if (cur >= today) return;
              const next = shiftIso(cur, 1);
              onViewDateChange(next >= today ? "" : next);
            }}
            disabled={!isHistorical}
            className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 transition disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title={isHistorical ? "Next day" : "Already on today"}
            aria-label="Next day"
          >
            <ChevronRight size={18} strokeWidth={2.5} />
          </button>
          {isHistorical && (
            <button
              onClick={() => onViewDateChange("")}
              data-testid="presence-back-to-today"
              className="ml-1 px-2.5 h-7 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-extrabold uppercase tracking-wider transition"
              title="Jump back to live today view"
            >
              Today
            </button>
          )}
        </div>
        <button
          data-testid="late-only-toggle"
          onClick={onToggleLateOnly}
          className={`inline-flex items-center gap-2 px-3 h-9 rounded-full text-xs font-semibold border transition ${
            lateOnly
              ? "bg-red-600 text-white border-transparent"
              : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
          }`}
          title="Show only members who are late today"
        >
          <Clock size={13} />
          {lateOnly ? `Showing late (${lateCount})` : `Late today · ${lateCount}`}
        </button>
        {absentCount > 0 && (
          <div className="inline-flex items-center gap-2 bg-red-50 border border-red-200 px-3 h-9 rounded-full text-xs font-semibold text-red-700">
            <UserX size={13} />
            {absentCount} absent
          </div>
        )}
        {canManageGuests && (
          <button
            data-testid="presence-add-guest"
            onClick={onAddGuest}
            className="inline-flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 text-white px-3 h-9 rounded-full text-xs font-bold transition"
            title="Check in a visitor (parent, prospect, dignitary)"
          >
            <UserPlus size={13} />
            Guest
            {activeGuestCount > 0 && (
              <span className="ml-1 px-1.5 h-5 rounded-full bg-white/25 text-[10px] flex items-center justify-center font-extrabold">
                {activeGuestCount}
              </span>
            )}
          </button>
        )}
        <div className="inline-flex items-center gap-2 bg-white border border-slate-200 px-3 h-9 rounded-full text-xs font-semibold text-slate-700">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          {totalMembers} members
        </div>
        <button onClick={onRefresh} className="iu-btn-secondary !h-9 !px-3" data-testid="presence-refresh-button">
          <RefreshCw size={14} />
        </button>
      </div>
    </header>
  );
}
