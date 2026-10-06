// Shared date/time formatters. `iso` = "YYYY-MM-DD" date or full ISO timestamp as noted.
const day = (iso, opts) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", opts);

// "Mon, 03 Jun 2026"
export const fmtDateLong = (iso) => iso ? day(iso, { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";
// "Mon, 03 Jun"
export const fmtDateWk = (iso) => iso ? day(iso, { weekday: "short", day: "2-digit", month: "short" }) : "";
// "Mon, 03 Jun 26"
export const fmtDateWkYY = (iso) => iso ? day(iso, { weekday: "short", day: "2-digit", month: "short", year: "2-digit" }) : "";
// "03 Jun"
export const fmtDateDM = (iso) => iso ? day(iso, { day: "2-digit", month: "short" }) : "";

// "03/06/26" from "2026-06-03"; raw value if not ISO-shaped.
export function fmtDDMMYY(iso) {
  if (!iso) return "—";
  const parts = String(iso).split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y.slice(-2)}`;
}

// Timestamp → "03 Jun 2026, 14:05" in IST.
export const fmtStampIst = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

// Timestamp → "14:05" in IST.
export const fmtHmIst = (iso, fallback = "") => iso
  ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
  : fallback;

// Date object → "14:05" in the browser's local time.
export function fmtHmLocal(d) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
