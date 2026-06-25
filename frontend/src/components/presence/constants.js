import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, Coffee, UserX } from "lucide-react";

// Order of the six columns on the Presence Board. `accent` is the bold
// brand colour used for the column rail + on-campus avatar ring. `soft`
// is the tinted column background. `badge` is the small count pill.
export const COLUMNS = [
  { key: "on_campus",  label: "On Campus",    icon: CheckCircle2, accent: "#10B981", soft: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  { key: "exited",     label: "Checked Out",  icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  { key: "on_tour",    label: "Tour",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "on_leave",   label: "Leave",        icon: Bed,          accent: "#F59E0B", soft: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  { key: "absent",     label: "Absent",       icon: UserX,        accent: "#DC2626", soft: "bg-red-50",      badge: "bg-red-100 text-red-700" },
];

// On Campus & Checked Out share a single sorted union so each member's row
// sits at the same vertical position in both columns (blank where the
// member isn't in that status). The two columns also scroll in lockstep.
export const PAIRED_COLUMN_KEYS = new Set(["on_campus", "exited"]);
