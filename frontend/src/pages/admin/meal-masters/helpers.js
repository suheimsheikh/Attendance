/**
 * MealMastersTab shared helpers — extracted 25 Jun 2026 (pure move).
 */
import { fmtQty as uQty } from "../../../utils";

export const fmt = (n, unit) => (n == null ? "—" : uQty(n, unit));

export const fmtRs = (n) =>
  n == null || !Number(n) ? "₹0.00" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const UNIT_OPTIONS = ["kg", "g", "L", "mL", "pcs", "dozen", "packet"];

// Shared column widths so the sticky header, category rows and item rows
// all line up in a single grid — 7 numeric columns on the right.
// Unit(w-14) Opening(w-24) Min(w-20) Norm(w-20) Purch(w-32) Issue(w-32) Close(w-32).
export const COL_GRID = "grid grid-cols-[2.75rem_5rem_3.5rem_3.5rem_7rem_7rem_7rem] gap-x-3 shrink-0";
