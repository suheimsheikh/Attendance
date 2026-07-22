/**
 * Ex-member helpers — shared by Members list, Presence Board, Muster
 * Roll, and the Reports Attendance table.
 *
 * 24 Feb 2026 user request: "How do I exit a person who has resigned
 * without disturbing attendance and balance leaves." — setting a
 * `leaving_date` flags the member as `ex` (Left). Historical data is
 * preserved; these helpers keep the visible surfaces clean by hiding
 * ex-members by default, with a one-click toggle to re-include them.
 */
import { todayIso } from "../utils";

/** True when the member has a `leaving_date` strictly in the past. */
export function isExMember(m, today = todayIso()) {
  const lv = (m?.leaving_date || "").trim();
  return !!lv && lv < today;
}

/** Apply the toggle-controlled filter to any list of member-like rows.
 *  When `showEx=true` the list is returned unchanged. */
export function filterEx(rows, showEx, today = todayIso()) {
  if (!rows) return rows;
  if (showEx) return rows;
  return rows.filter((r) => !isExMember(r, today));
}
