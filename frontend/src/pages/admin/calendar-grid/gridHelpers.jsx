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
  LT: { bg: "bg-orange-500",     text: "text-white",       label: "LT", title: "Late" },
  LV: { bg: "bg-amber-200",      text: "text-amber-800",   label: "LV", title: "Leave" },
  TR: { bg: "bg-orange-200",     text: "text-orange-800",  label: "TR", title: "Tour" },
  PS: { bg: "bg-slate-200",      text: "text-slate-700",   label: "PS", title: "Posting" },
  CO: { bg: "bg-sky-200",        text: "text-sky-800",     label: "CO", title: "Comp-off" },
  WO: { bg: "bg-slate-100",      text: "text-slate-500",   label: "WO", title: "Weekly off" },
  HO: { bg: "bg-violet-100",     text: "text-violet-700",  label: "HO", title: "Holiday" },
  BK: { bg: "bg-fuchsia-200",    text: "text-fuchsia-800", label: "BK", title: "Break (member-scoped)" },
  AB: { bg: "bg-red-500",        text: "text-white",       label: "AB", title: "Absent" },
};

/** One cell in a member's row for a given date. `code` may be null
 * (future date) — renders an empty aligned slot. `meta` is an optional
 * per-cell payload from the backend (`row.cell_meta[iso]`) that we
 * unpack into a rich multi-line tooltip — Break name & applied-by for
 * BK cells, check-in / late-minutes for LT/P/HD, leave reason + range
 * for LV/TR/CO/PS. Kept as a native `title` (no JS popover library) so
 * the whole 31-day grid stays fast when hovering across 100 rows. */
export function GridCell({ code, dow, onClick, meta, iso }) {
  if (!code) {
    return <td className="border border-slate-100 text-center text-slate-300 tabular-nums h-6 w-7">·</td>;
  }
  const s = CELL_STYLE[code] || CELL_STYLE.AB;
  const clickable = !!onClick;
  const title = buildCellTooltip({ code, dow, meta, iso, clickable });
  return (
    <td
      className={`border border-white text-center text-[10px] font-bold ${s.bg} ${s.text} h-6 w-7 leading-none ${clickable ? "cursor-pointer hover:ring-2 hover:ring-sky-500 hover:ring-offset-1 transition" : ""}`}
      title={title}
      onClick={onClick}
    >
      {s.label}
    </td>
  );
}

/** Format an ISO timestamp as local "HH:MM" (browser local, which
 * matches admin's IST expectation in prod). Falls back to '?' on
 * unparseable input so a broken row still renders. */
function fmtHM(iso) {
  if (!iso) return "";
  try {
    const dt = new Date(iso);
    return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  } catch { return "?"; }
}

function fmtDateShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

/** Build the native tooltip string for a Grid cell. Multi-line so the
 * OS renders it in a stack — no external popover library needed.
 * Explicitly ordered so break cells lead with the break's name, leaves
 * lead with the reason, and P/LT lead with the check-in time. */
export function buildCellTooltip({ code, dow, meta, iso, clickable }) {
  const s = CELL_STYLE[code] || {};
  const lines = [];
  const header = [s.title || code, dow, iso ? fmtDateShort(iso) : null]
    .filter(Boolean).join(" · ");
  lines.push(header);
  const m = meta || {};
  if (code === "BK") {
    if (m.break_name)    lines.push(`Break: ${m.break_name}`);
    if (m.range)         lines.push(`Window: ${m.range}`);
    if (m.applied_by)    lines.push(`Applied by ${m.applied_by}${m.applied_at ? " on " + fmtDateShort(m.applied_at) : ""}`);
  } else if (["LV", "TR", "CO", "PS"].includes(code)) {
    if (m.half_day)      lines.push(`Half day (${m.half_day})`);
    if (m.range)         lines.push(`Window: ${m.range}`);
    if (m.reason)        lines.push(`Reason: ${m.reason}`);
    if (m.approved_by)   lines.push(`Approved by ${m.approved_by}`);
  } else if (["P", "LT", "HD"].includes(code)) {
    if (m.check_in_at)   lines.push(`In: ${fmtHM(m.check_in_at)}`);
    if (m.check_out_at)  lines.push(`Out: ${fmtHM(m.check_out_at)}`);
    if (m.late_minutes)  lines.push(`Late by ${m.late_minutes}m`);
    if (m.ot_minutes)    lines.push(`OT: ${Math.floor(m.ot_minutes / 60)}h ${m.ot_minutes % 60}m`);
  }
  if (clickable) lines.push("Click to file correction");
  return lines.join("\n");
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
