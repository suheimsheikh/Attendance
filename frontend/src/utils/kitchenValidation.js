/**
 * Shared "idiot-proof" validation for all kitchen data entry (Jun 2026).
 *
 * Rules agreed with the user:
 *   • Quantity / Rate / Price / Amount must be > 0 (block 0, blank,
 *     negative and non-numeric) — EXCEPT stock-take counts, where a
 *     physical count of 0 is legitimate (pass { allowZero: true }).
 *   • Hard ceilings catch fat-finger typos (e.g. a rate in paise, or a
 *     qty with an extra zero).
 * A fully-blank cell on a catalogue grid means "no transaction for this
 * item" and is skipped by the caller — these helpers only judge a value
 * once the user has actually typed something.
 */
export const MAX_QTY = 100000;
export const MAX_RATE = 100000;
export const MAX_AMOUNT = 10000000;

// "" / null → null (blank); non-numeric → NaN; else the number.
export const toNum = (v) => {
  if (v === "" || v == null) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : NaN;
};

const fmt = (n) => n.toLocaleString("en-IN");

// Returns "" when valid, else a short human error message.
export function numberError(raw, { label = "Value", allowZero = false, max = MAX_QTY } = {}) {
  const x = toNum(raw);
  if (x === null) return `${label} is required`;
  if (Number.isNaN(x)) return `${label} must be a number`;
  if (allowZero) {
    if (x < 0) return `${label} can't be negative`;
  } else if (x <= 0) {
    return `${label} must be greater than 0`;
  }
  if (x > max) return `${label} looks too large — max ${fmt(max)}. Please re-check.`;
  return "";
}

export const qtyError = (raw, o = {}) => numberError(raw, { label: "Qty", max: MAX_QTY, ...o });
export const rateError = (raw, o = {}) => numberError(raw, { label: "Rate", max: MAX_RATE, ...o });
export const amountError = (raw, o = {}) => numberError(raw, { label: "Amount", max: MAX_AMOUNT, ...o });

// A cell the user has started filling (non-blank). Blank = skipped row.
export const isStarted = (v) => v !== "" && v != null;
