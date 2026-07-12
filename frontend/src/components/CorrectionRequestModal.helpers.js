/**
 * Static helpers extracted from CorrectionRequestModal so the main
 * component stays under the code-review complexity ceiling. Pure
 * functions + constants — no state, no side effects, no React.
 *
 * 20 Feb 2026 (Phase 1 of the "gradually reduce complexity" refactor
 * plan). Split intentionally mechanical — behaviour is byte-identical
 * to what used to live at the top of `CorrectionRequestModal.jsx`.
 */

/** Human-readable labels for the "what's wrong?" dropdown. */
export const KIND_LABELS = {
  missed_checkin:    "I forgot to punch in",
  time_adjust:       "My check-in time is wrong",
  leave_date_change: "The dates on my leave are wrong",
  leave_cancel:      "Cancel this leave — shouldn't have run",
  leave_type_change: "Change the leave type",
};

/** Kinds grouped by entity_type — drives the dropdown when the caller
 * hasn't hard-locked a specific kind (e.g. from a generic corrections
 * button). */
export const KINDS_BY_ENTITY = {
  attendance: ["missed_checkin", "time_adjust"],
  leave:      ["leave_date_change", "leave_cancel", "leave_type_change"],
};

/** Latest date a correction can target — corrections are capped at
 * "today" (future dates are never valid). */
export function windowMaxDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Earliest date a correction can target — 31-day retro window (was 7,
 * expanded 9 Feb 2026 per user request so admins can fix late-reported
 * check-in times / missed punches for an entire month). Non-admin
 * self-filed requests are still capped at 7 days by the backend
 * `_enforce_window` guard; admins bypass that check server-side. */
export function windowMinDate() {
  const d = new Date();
  d.setDate(d.getDate() - 31);
  return d.toISOString().slice(0, 10);
}
