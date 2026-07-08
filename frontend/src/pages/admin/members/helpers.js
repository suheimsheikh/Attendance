import React from "react";

// Category buckets — these match the `category` field on the user doc.
// `admin` is intentionally absent: it's a ROLE (orthogonal to category) and is
// rendered as its own toggle further down + as a badge on each row. A coach
// who is also an admin appears under "Coaches" AND lights up the Admin chip.
export const BUCKETS = [
  { key: "all",       label: "All",        dotBg: "bg-slate-400",   activeBg: "bg-slate-900",   activeText: "text-white", inactiveBg: "bg-slate-100",  inactiveText: "text-slate-700",   inactiveBorder: "border-slate-200",  stripe: "",               rowHover: "" },
  { key: "coach",     label: "Coaches",    dotBg: "bg-emerald-500", activeBg: "bg-emerald-600", activeText: "text-white", inactiveBg: "bg-emerald-50", inactiveText: "text-emerald-700", inactiveBorder: "border-emerald-200",stripe: "bg-emerald-500", rowHover: "hover:bg-emerald-50/60" },
  { key: "staff",     label: "Staff",      dotBg: "bg-amber-500",   activeBg: "bg-amber-600",   activeText: "text-white", inactiveBg: "bg-amber-50",   inactiveText: "text-amber-700",   inactiveBorder: "border-amber-200",  stripe: "bg-amber-500",   rowHover: "hover:bg-amber-50/60" },
  { key: "executive", label: "Executives", dotBg: "bg-violet-500",  activeBg: "bg-violet-600",  activeText: "text-white", inactiveBg: "bg-violet-50",  inactiveText: "text-violet-700",  inactiveBorder: "border-violet-200", stripe: "bg-violet-500",  rowHover: "hover:bg-violet-50/60" },
  { key: "athlete",   label: "Athletes",   dotBg: "bg-sky-500",     activeBg: "bg-sky-600",     activeText: "text-white", inactiveBg: "bg-sky-50",     inactiveText: "text-sky-700",     inactiveBorder: "border-sky-200",    stripe: "bg-sky-500",     rowHover: "hover:bg-sky-50/60" },
  { key: "elite",     label: "Elite",      dotBg: "bg-rose-500",    activeBg: "bg-rose-600",    activeText: "text-white", inactiveBg: "bg-rose-50",    inactiveText: "text-rose-700",    inactiveBorder: "border-rose-200",   stripe: "bg-rose-500",    rowHover: "hover:bg-rose-50/60" },
];
export const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

// Returns the CATEGORY bucket — never "admin". Admin is rendered separately as
// a badge on the row and as an orthogonal filter toggle above the table.
export const bucketOf = (m) => m.category || "athlete";

export const GENDER_LABEL = { M: "Male", F: "Female", O: "Other" };

// Render the "Last seen" column. Friendly relative labels for the common
// cases (today / yesterday / N days ago), absolute date if older than a
// month so the value stays meaningful at any scale.
export function lastSeenLabel(iso, today) {
  if (!iso) return <span className="text-slate-400">Never</span>;
  if (iso === today) return <span className="text-emerald-700 font-semibold">Today</span>;
  // YYYY-MM-DD diff in days. Both inputs are local-date strings (no TZ).
  const d1 = new Date(iso + "T12:00:00");
  const d2 = new Date(today + "T12:00:00");
  const diff = Math.round((d2 - d1) / 86400000);
  if (diff === 1) return <span className="text-slate-700">Yesterday</span>;
  if (diff < 7) return <span className="text-slate-700">{diff} days ago</span>;
  if (diff < 30) return <span className="text-amber-700">{diff} days ago</span>;
  // Absolute date for anything ≥ 30 days — easier to interpret than "127 days ago".
  return <span className="text-red-700 font-semibold">
    {new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
  </span>;
}

// Render the "Leave balance" column. Only meaningful for non-athletes
// (the leave-tracked cohort = coach + staff + executive). Athletes AND
// Elite use the Breaks workflow instead so we deliberately show em-dash.
export function leaveBalanceLabel(m) {
  if (m.category === "athlete" || m.category === "elite") return <span className="text-slate-300">—</span>;
  const opening = m.leave_balance_opening;
  const remaining = m.leave_balance_remaining;
  if (opening == null) return <span className="text-slate-400" title="No opening balance set">—</span>;
  const tone = remaining < 0 ? "text-red-700" : remaining < 3 ? "text-amber-700" : "text-slate-700";
  return (
    <span className={`font-mono ${tone}`} title={`Opening ${opening} − YTD taken ${(opening - remaining).toFixed(1)} = ${remaining}`}>
      {remaining}<span className="text-slate-400">/{opening}</span>
    </span>
  );
}

// Open the edit modal when a row is double-clicked — but only when the click
// didn't originate from an interactive element (inputs / buttons / labels for
// photo upload), otherwise the parent-mobile editor double-click-to-select
// gesture would surprise admins with a modal.
export const isInteractive = (target) => {
  const el = target?.closest?.("input, button, select, textarea, a, label");
  return !!el;
};
