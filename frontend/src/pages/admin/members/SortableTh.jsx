/**
 * SortableTh — one column header wrapped as a clickable button that
 * cycles through unsorted → ascending → descending for the given
 * member field. The parent Members page owns the sort state and
 * passes back an `onSort(k)` handler.
 *
 * Extracted from Members.jsx on 15 Feb 2026. Pure presentational.
 */
import React from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

// Per-column tooltip help — surfaces the semantics of each field on
// hover of the sort button. Kept co-located with the component so
// changes to labels + help stay in one place.
export const COL_HELP = {
  edit:         "Open the full edit form · file a correction on the member's behalf.",
  full_name:    "Full name, email, and parent-contact shortcut. Click the name to rename in place.",
  category:     "Athlete / Elite / Coach / Staff / Executive. Click the pill to reassign.",
  role:         "Admin (has console access) or Member. Orthogonal to category — a coach can also be admin.",
  rank:         "Job title / rank shown next to the name (e.g. Petty Officer, Head Coach).",
  gender:       "Male / Female / Other. Powers gender-specific reporting.",
  mobile:       "Primary mobile number used for SMS + WhatsApp notifications.",
  institution:  "Affiliated school, college, or organisation. Manage the list under Admin → Institutions.",
  fleet:        "Boat class — athletes only. Manage the list under Admin → Fleets.",
  last_seen_date:"Most recent check-in date. 'Today' means already checked in today.",
  leave_balance_opening:"Remaining / Opening annual leave balance (staff / coach / executive only).",
  work_start:   "Working hours (start – end). Powers overtime and late-arrival calculations.",
  weekly_off:   "Weekly off-day. Working on this day earns a compensatory off.",
  date_of_birth:"Date of birth. Powers birthday greetings on the Check-In screen.",
  ot_eligible:  "Overtime eligibility toggle. Athletes never accrue OT regardless of this setting.",
  parents:      "Parent + guardian names and mobile numbers. Editable in place.",
  status:       "Live presence — On campus, On leave, On tour, Absent, etc.",
  del:          "Delete member. This also removes their attendance and leave history — irreversible.",
};

export default function SortableTh({
  k, sortKey, sortDir, onSort, align = "left", className = "", children,
}) {
  const active = sortKey === k && !!sortDir;
  const justify = align === "center" ? "justify-center" : "justify-start";
  const desc = COL_HELP[k] || "";
  const tip = desc
    ? `${desc}\n\nClick to sort${active ? ` — currently ${sortDir === "asc" ? "A → Z" : "Z → A"}` : ""}.`
    : `Sort by ${k}${active ? ` (${sortDir})` : ""} — click again to change direction`;
  // Inactive-state indicator: stack an up + down chevron with ~5 mm of
  // vertical separation. Using two icons instead of `ChevronsUpDown`
  // gives us explicit control over the gap.
  const indicator = active ? (
    (sortDir === "asc" ? <ChevronUp size={18} strokeWidth={2.75} className="text-sky-600" />
                       : <ChevronDown size={18} strokeWidth={2.75} className="text-sky-600" />)
  ) : (
    <div className="flex flex-col items-center justify-between h-[42px] w-3 shrink-0" aria-hidden="true">
      <ChevronUp   size={12} strokeWidth={2.5} className="text-slate-400" />
      <ChevronDown size={12} strokeWidth={2.5} className="text-slate-400" />
    </div>
  );
  return (
    <th className={`iu-table-th ${align === "center" ? "text-center" : ""} ${className}`}>
      <button
        type="button"
        data-testid={`sort-${k}`}
        onClick={() => onSort(k)}
        title={tip}
        className={`flex items-center gap-2 w-full ${justify} cursor-pointer select-none transition-colors hover:text-slate-900 ${active ? "text-slate-900 font-extrabold" : "text-slate-700 font-bold"}`}
      >
        <span className="tracking-wide">{children}</span>
        {indicator}
      </button>
    </th>
  );
}
