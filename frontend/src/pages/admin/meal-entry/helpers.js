/**
 * MealEntryTab pure helpers — extracted 25 Jun 2026 as part of the
 * incremental split of the 1650-line parent. No state, no side effects.
 */

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

export const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);

export const inr = (n) =>
  n == null ? "0.00" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
