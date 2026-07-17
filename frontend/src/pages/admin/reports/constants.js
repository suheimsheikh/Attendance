// Reports page constants — split out of Reports.jsx (17 Feb 2026 refactor).

export const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  // Elite is athlete-like but coaches asked for a dedicated pill to
  // drill into just the Elite cohort (~18-strong at YCH) without
  // exporting. Filter matches `r.category === "elite"` literally so it
  // stays deterministic even if new athlete-like categories get added.
  { key: "elite",   label: "Elite" },
  // "Rest" (renamed to "Staff & Coaches" 7 Jul 2026 on user request)
  // collapses staff/coach/executive into one bucket — matches the
  // way admins actually think about the two populations at YCH.
  { key: "rest",    label: "Staff & Coaches" },
  // "Escorts" surfaces members who accompanied a parent-escort in the
  // window (7 Jul 2026 user-requested). Filter is applied client-side
  // against the row's escort_days count.
  { key: "escorts", label: "Escorts" },
];

export const SORT_OPTIONS = [
  { key: "alpha", label: "A → Z" },
  { key: "pct_desc", label: "Attendance %" },
];

export const VALID_TABS = new Set(["attendance", "calendar", "daily"]);
