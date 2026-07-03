import React, { useMemo, useState } from "react";
import { CheckSquare, Loader2, X } from "lucide-react";

/**
 * BulkEditBar — sticky bottom toolbar that lets an admin apply the same
 * value to one cohort-level field across many selected members.
 *
 * Renders ONLY when `selectedCount > 0`. Caller wires the action via
 * `onApply(field, value)` and a Clear-selection via `onClear()`.
 *
 * The field picker exposes a fixed allowlist that mirrors the backend
 * `BULK_MEMBER_ALLOWED_FIELDS` constant (category / role / institution /
 * fleet / weekly_off / gender). Per-individual fields (name, mobile,
 * leave_balance_opening, etc.) are intentionally absent.
 */
export default function BulkEditBar({
  selectedCount,
  onClear,
  onApply,
  fleetOptions,
  institutionOptions,
  categoryOptions,
  roleOptions,
  weeklyOffOptions,
  genderOptions,
}) {
  const [field, setField] = useState("fleet");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  // Field → options lookup. Keeps the JSX flat and the source of truth
  // explicit — adding a new bulk field is one line in this map plus one
  // entry in the <option> list below + one allowlist entry on the backend.
  const optionsByField = {
    fleet: fleetOptions,
    institution: institutionOptions,
    category: categoryOptions,
    role: roleOptions,
    weekly_off: weeklyOffOptions,
    gender: genderOptions,
  };
  const currentOpts = optionsByField[field] || [];

  // Options minus the "no-op empty" entry — that placeholder is rendered
  // separately below alongside the synthetic __CLEAR__ sentinel. Memoised
  // so the list isn't re-filtered on every keystroke or busy-state flip.
  // Depend on the specific per-field options prop (stable across renders
  // from parent) rather than the freshly-allocated `currentOpts` array.
  const pickableOpts = useMemo(
    () => (currentOpts || []).filter((o) => o.value !== ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentOpts identity depends on `field` + upstream props; we use those directly
    [field, fleetOptions, institutionOptions, categoryOptions, roleOptions, weeklyOffOptions, genderOptions]
  );

  if (selectedCount === 0) return null;

  const apply = async () => {
    // For category/role/gender/weekly_off the empty string means "clear"
    // which is a legitimate operation (e.g. unset weekly_off across rows).
    // We send the raw value — backend handles `null` vs `""` correctly via
    // the same exclude_unset/Optional-Literal pipeline as single PATCH.
    setBusy(true);
    try {
      await onApply(field, value === "" ? null : value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="bulk-edit-bar"
      className="fixed left-0 right-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.18)]"
    >
      <div className="max-w-[1600px] mx-auto px-4 md:px-8 py-3 flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-2 px-3 h-8 rounded-full bg-sky-50 text-sky-700 border border-sky-200 font-semibold text-sm" data-testid="bulk-count">
          <CheckSquare size={14} />
          {selectedCount} selected
        </span>
        <span className="text-slate-400 text-sm hidden md:inline">Apply</span>
        <select
          data-testid="bulk-field"
          value={field}
          onChange={(e) => { setField(e.target.value); setValue(""); }}
          className="iu-input !h-9 !text-sm !w-40"
        >
          <option value="fleet">Fleet</option>
          <option value="category">Category</option>
          <option value="role">Admin role</option>
          <option value="institution">Institution</option>
          <option value="weekly_off">Weekly off</option>
          <option value="gender">Gender</option>
        </select>
        <span className="text-slate-400 text-sm hidden md:inline">=</span>
        <select
          data-testid="bulk-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="iu-input !h-9 !text-sm !w-44"
        >
          <option value="">— pick a value —</option>
          {pickableOpts.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
          {/* Explicit "clear" option, so admins can wipe a field across many
              members in one click (e.g. blank out everyone's weekly_off). */}
          <option value="__CLEAR__">— Clear this field —</option>
        </select>
        <button
          type="button"
          data-testid="bulk-apply"
          disabled={busy || value === ""}
          onClick={() => {
            // Translate the synthetic "__CLEAR__" sentinel back to an empty
            // string before handing off — keeps the apply() contract clean.
            if (value === "__CLEAR__") onApply(field, null).finally(() => {});
            else apply();
          }}
          className="iu-btn-primary !h-9 !px-4 inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Apply to {selectedCount}
        </button>
        <button
          type="button"
          data-testid="bulk-clear"
          onClick={onClear}
          className="ml-auto inline-flex items-center gap-1.5 px-3 h-9 rounded-md text-sm text-slate-600 hover:bg-slate-100"
        >
          <X size={14} /> Clear selection
        </button>
      </div>
    </div>
  );
}
