// Shared constants + date helpers for Calendar.jsx, DayDetailModal,
// RegattaForm, and BreakForm. Pure, stateless — safe to import anywhere.

export const LEVEL_STYLE = {
  international: { chip: "bg-violet-100 text-violet-700",   dot: "#7C3AED", label: "International" },
  national:      { chip: "bg-amber-100 text-amber-700",     dot: "#D97706", label: "National" },
  state:         { chip: "bg-sky-100 text-sky-700",         dot: "#0284C7", label: "State" },
  club:          { chip: "bg-slate-200 text-slate-700",     dot: "#475569", label: "Club" },
};
export const LEVELS = ["international", "national", "state", "club"];

// Camp days-of-week filter — backend stores ["mon","tue",…]. JS getDay() is 0=Sun.
export const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Break scope picker options shared by BreakForm + the list-row label
// renderer in Calendar.jsx (`scopeLabel`).
export const SCOPES = [
  { key: "all",         label: "Holiday for everyone",     hint: "Office-wide day off — every member is on break" },
  { key: "athletes",    label: "Rest day · all athletes",  hint: "Every athlete, regardless of institution" },
  { key: "coaches",     label: "All coaches",              hint: "Every coach on the roster" },
  { key: "staff",       label: "All staff",                hint: "Every staff member" },
  { key: "institution", label: "One institution",          hint: "Every athlete in the chosen institution" },
  { key: "fleet",       label: "One fleet",                hint: "Every athlete in the chosen boat class" },
  { key: "selected",    label: "Selected members",         hint: "Pick the exact members below" },
];

export function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
export function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
export function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
export function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

// Human-readable scope label for break list rows.
export function scopeLabel(b) {
  switch (b.scope) {
    case "all": return "Everyone";
    case "athletes": return "All athletes";
    case "coaches": return "All coaches";
    case "staff": return "All staff";
    case "institution": return b.institution || "Institution";
    case "fleet": return b.fleet ? `Fleet: ${b.fleet}` : "Fleet";
    case "selected": return "Selected";
    default: return "Break";
  }
}
