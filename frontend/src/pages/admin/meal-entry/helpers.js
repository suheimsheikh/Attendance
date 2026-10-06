import { money } from "../../../utils";
/**
 * MealEntryTab pure helpers — extracted 25 Jun 2026 as part of the
 * incremental split of the 1650-line parent. No state, no side effects.
 */

export const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);

export const inr = (n) => money(n, 2, "0.00");
