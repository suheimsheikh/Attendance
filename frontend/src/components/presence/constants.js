import { CheckCircle2, Plane, LogOut as ExitIcon, Coffee, UserX } from "lucide-react";

// Order of the columns on the Presence Board (5 columns since 8 Jul 2026:
// Tour + Leave merged into one "Away" column with per-member colour
// pills so the board can dedicate more horizontal space to the
// operationally-important columns).
// `accent` is the bold brand colour used for the column rail + on-campus
// avatar ring. `soft` is the tinted column background. `badge` is the
// small count pill in the header.
export const COLUMNS = [
  { key: "on_campus",  label: "On Campus",    icon: CheckCircle2, accent: "#10B981", soft: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  { key: "exited",     label: "Checked Out",  icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  // Combined column — receives both on_tour and on_leave members. Per-
  // row colour pills (orange = tour, amber = leave) preserve the
  // distinction inside the column.
  { key: "away",       label: "Away",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "absent",     label: "Absent",       icon: UserX,        accent: "#DC2626", soft: "bg-red-50",      badge: "bg-red-100 text-red-700" },
];

// Which raw member.status values feed into which column. Kept separate
// from COLUMNS so the bucketing logic in Presence.jsx stays declarative.
export const STATUS_TO_COLUMN = {
  on_campus: "on_campus",
  exited:    "exited",
  temp_out:  "temp_out",
  on_tour:   "away",
  on_leave:  "away",
  absent:    "absent",
};

// Per-status accent applied to individual rows inside the merged "Away"
// column so admins can still tell tour apart from leave at a glance.
export const AWAY_STATUS_STYLE = {
  on_tour:  { chip: "bg-orange-100 text-orange-800 border border-orange-200", label: "Tour",  dot: "bg-orange-500" },
  on_leave: { chip: "bg-amber-100 text-amber-800 border border-amber-200",   label: "Leave", dot: "bg-amber-500" },
};
