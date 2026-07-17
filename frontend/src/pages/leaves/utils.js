/**
 * Shared constants + tiny formatters for the Leaves module. Extracted
 * 14 Feb 2026 so the three sub-components (StatsDashboard, StatCard,
 * MyLeaveRow) can consume them without living in the same file.
 *
 * `round1` was also duplicated in admin/LeaveBalances.jsx and
 * admin/Leaves.jsx — those copies can be swapped for this import in
 * a follow-up pass.
 */
import { Bed, Plane, RefreshCw, Briefcase, Clock } from "lucide-react";

export const TYPE_LABELS = {
  leave:        { label: "Leave",        color: "#F59E0B", Icon: Bed },
  tour:         { label: "Tour",         color: "#F97316", Icon: Plane },
  posting:      { label: "Posted",       color: "#0EA5E9", Icon: Briefcase },
  // Legacy comp_off type — no longer applicable but historical rows still
  // reference it. Keep the label for read-back rendering.
  comp_off:     { label: "Comp Off",     color: "#8B5CF6", Icon: RefreshCw },
  late_coming:  { label: "Late Coming",  color: "#DC2626", Icon: Clock },
};

export const STATUS_COLORS = {
  pending:  { bg: "rgba(245,158,11,0.12)", color: "#B45309" },
  approved: { bg: "rgba(16,185,129,0.12)", color: "#047857" },
  rejected: { bg: "rgba(239,68,68,0.12)", color: "#B91C1C" },
};

/** Colour palette used by StatCard — same 6-tone system as the Grid. */
export const TONE = {
  amber:   { border: "border-amber-200",   bg: "bg-amber-50/60",   text: "text-amber-700",   value: "text-amber-900",   icon: "text-amber-600"   },
  violet:  { border: "border-violet-200",  bg: "bg-violet-50/60",  text: "text-violet-700",  value: "text-violet-900",  icon: "text-violet-600"  },
  emerald: { border: "border-emerald-300", bg: "bg-emerald-50/80", text: "text-emerald-700", value: "text-emerald-900", icon: "text-emerald-700" },
  sky:     { border: "border-sky-200",     bg: "bg-sky-50/60",     text: "text-sky-700",     value: "text-sky-900",     icon: "text-sky-600"     },
  orange:  { border: "border-orange-200",  bg: "bg-orange-50/60",  text: "text-orange-700",  value: "text-orange-900",  icon: "text-orange-600"  },
  red:     { border: "border-red-300",     bg: "bg-red-50/70",     text: "text-red-700",     value: "text-red-900",     icon: "text-red-600"     },
  slate:   { border: "border-slate-200",   bg: "bg-white",         text: "text-slate-500",   value: "text-slate-900",   icon: "text-slate-400"   },
};

/** Round to 1 decimal place. Safe against null / NaN inputs. */
export function round1(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 10) / 10;
}
