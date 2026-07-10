/**
 * CalendarGrid helpers — extracted from CalendarGridTab.jsx on
 * 15 Feb 2026 as part of the incremental split of the 463-line parent.
 *
 * Everything here is pure (no state, no side effects) — the parent
 * imports and composes them with the grid data.
 */
import React from "react";

// Cell colour + label registry. Each entry maps a status code to
// tailwind bg + text classes and the display label (2-letter code).
export const CELL_STYLE = {
  P:  { bg: "bg-emerald-500",    text: "text-white",       label: "P",  title: "Present" },
  HD: { bg: "bg-amber-100",      text: "text-amber-700",   label: "HD", title: "Half day" },
  LT: { bg: "bg-emerald-500/70", text: "text-amber-100",   label: "LT", title: "Late" },
  LV: { bg: "bg-amber-200",      text: "text-amber-800",   label: "LV", title: "Leave" },
  TR: { bg: "bg-orange-200",     text: "text-orange-800",  label: "TR", title: "Tour" },
  PS: { bg: "bg-slate-200",      text: "text-slate-700",   label: "PS", title: "Posting" },
  CO: { bg: "bg-sky-200",        text: "text-sky-800",     label: "CO", title: "Comp-off" },
  WO: { bg: "bg-slate-100",      text: "text-slate-500",   label: "WO", title: "Weekly off" },
  HO: { bg: "bg-violet-100",     text: "text-violet-700",  label: "HO", title: "Holiday" },
  AB: { bg: "bg-red-500",        text: "text-white",       label: "AB", title: "Absent" },
};

/** One cell in a member's row for a given date. `code` may be null
 * (future date) — renders an empty aligned slot. */
export function GridCell({ code, dow, onClick }) {
  if (!code) {
    return <td className="border border-slate-100 text-center text-slate-300 tabular-nums h-6 w-7">·</td>;
  }
  const s = CELL_STYLE[code] || CELL_STYLE.AB;
  const clickable = !!onClick;
  return (
    <td
      className={`border border-white text-center text-[10px] font-bold ${s.bg} ${s.text} h-6 w-7 leading-none ${clickable ? "cursor-pointer hover:ring-2 hover:ring-sky-500 hover:ring-offset-1 transition" : ""}`}
      title={`${s.title}${dow ? " · " + dow : ""}${clickable ? " · click to file correction" : ""}`}
      onClick={onClick}
    >
      {s.label}
    </td>
  );
}

/** Map a cell code to the best default correction (kind + entityType)
 * so the modal opens straight to the right form section. Cells that
 * don't map to a useful correction (WO / HO) return null. */
export function correctionForCode(code) {
  switch (code) {
    case "AB":               return { entityType: "attendance", initialKind: "missed_checkin" };
    case "LT":
    case "P":
    case "HD":               return { entityType: "attendance", initialKind: "time_adjust" };
    case "LV":
    case "TR":
    case "CO":
    case "PS":               return { entityType: "leave", initialKind: "leave_cancel" };
    default:                 return null;   // WO, HO — nothing sensible to correct
  }
}

/** Format OT minutes → compact "1h 30m" / "45m" / "" (empty when zero). */
export function fmtOt(mins) {
  const m = Number(mins || 0);
  if (m <= 0) return "";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`;
}
