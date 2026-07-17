/**
 * ReasonPrompt — the OT and Early-out reason cards that appear above
 * the check-in/out button on SelfCheckIn. Both cards follow the same
 * shape (icon + headline + optional ReasonPicker + fine print), so
 * they're implemented as one config-driven component and mounted
 * twice from SelfCheckIn.
 *
 * Extracted 14 Feb 2026 (item H of the low-risk refactor pass). Zero
 * behaviour change — the render is byte-identical to what used to sit
 * inline in SelfCheckIn.jsx around L300–333.
 */
import React from "react";
import { AlertTriangle } from "lucide-react";
import ReasonPicker from "./ReasonPicker";

/**
 * @param {"amber" | "rose"} variant — colour theme (OT = amber, early-out = rose)
 * @param {string} headline — one-line context (e.g. "You're checking out 42 min after your end time (18:00)")
 * @param {string} labelText — label above the ReasonPicker
 * @param {string} placeholder — placeholder for the reason input
 * @param {string} footnote — small print explaining what the note is used for
 * @param {string} value — controlled reason string
 * @param {(v: string) => void} onChange — reason setter
 * @param {string} testId — used for both the card wrapper and the ReasonPicker input
 */
export default function ReasonPrompt({
  variant,
  headline,
  labelText,
  placeholder,
  footnote,
  value,
  onChange,
  testId,
}) {
  const isAmber = variant === "amber";
  const styles = isAmber ? {
    wrap: "border-amber-200 bg-amber-50",
    iconText: "text-amber-700",
    headline: "text-amber-800",
    label: "text-amber-900",
    footnote: "text-amber-700",
  } : {
    wrap: "border-rose-200 bg-rose-50",
    iconText: "text-rose-700",
    headline: "text-rose-800",
    label: "text-rose-900",
    footnote: "text-rose-700",
  };
  return (
    <div
      className={`mb-5 text-left rounded-xl border ${styles.wrap} p-3`}
      data-testid={`${testId}-block`}
    >
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle size={14} className={`${styles.iconText} mt-0.5 shrink-0`} />
        <div className={`text-xs font-semibold ${styles.headline}`}>{headline}</div>
      </div>
      <label className={`iu-label ${styles.label}`}>{labelText}</label>
      <ReasonPicker
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        variant={variant}
        testId={testId}
      />
      <p className={`text-[11px] mt-1.5 ${styles.footnote}`}>{footnote}</p>
    </div>
  );
}
