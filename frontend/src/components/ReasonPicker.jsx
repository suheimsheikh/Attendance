import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../api";

/**
 * ReasonPicker — small controlled input that suggests reasons from the
 * caller's personal reason bank (built up automatically as they file
 * OT and comp-off requests) alongside a free-text field for one-offs.
 *
 * Contract:
 *  - `value` / `onChange` — controlled string of the currently-picked
 *    reason. Empty string means "no reason yet".
 *  - `placeholder` — hint text on the free-text input.
 *  - `disabled` — pass-through to the underlying inputs.
 *  - `variant` — "amber" (OT prompts), "rose" (early-out prompt), or "slate" (comp-off apply).
 *    Only tweaks background tint so the picker slots into whichever
 *    surrounding card it's placed inside.
 *  - `testId` — data-testid namespace so multiple pickers on-page
 *    don't collide.
 *
 * Behaviour:
 *  - On mount, fetches `/api/me/reasons` (silent — empty list on
 *    error). No blocking spinner because the free-text still works
 *    even when the bank is unavailable.
 *  - Clicking a suggestion sets `value` immediately (typing on top of
 *    it edits the free-text and drops the chip highlight).
 *  - The list shows at most 8 suggestions to keep the picker compact.
 */
export default function ReasonPicker({
  value,
  onChange,
  placeholder = "Type a reason…",
  disabled = false,
  variant = "amber",
  testId = "reason-picker",
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.get("/me/reasons")
      .then((res) => { if (!cancelled) setSuggestions(res?.reasons || []); })
      .catch(() => { /* silent — bank is opportunistic */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const chipBase =
    variant === "amber"
      ? "border-amber-300 bg-white text-amber-900 hover:bg-amber-100"
      : variant === "rose"
        ? "border-rose-300 bg-white text-rose-900 hover:bg-rose-100"
        : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100";
  const chipActive =
    variant === "amber"
      ? "border-amber-500 bg-amber-500 text-white"
      : variant === "rose"
        ? "border-rose-500 bg-rose-500 text-white"
        : "border-slate-700 bg-slate-800 text-white";

  return (
    <div data-testid={testId}>
      <textarea
        data-testid={`${testId}-input`}
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="iu-input !h-auto py-2 w-full"
      />
      {loading ? (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
          <Loader2 className="animate-spin" size={11} /> loading your reasons…
        </div>
      ) : suggestions.length > 0 ? (
        <div className="mt-2" data-testid={`${testId}-suggestions`}>
          <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">
            Your previous reasons
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.slice(0, 8).map((r) => {
              const active = (value || "").trim().toLowerCase() === r.toLowerCase();
              return (
                <button
                  key={r}
                  type="button"
                  data-testid={`${testId}-suggestion`}
                  onClick={() => onChange(r)}
                  disabled={disabled}
                  className={`text-[11px] px-2 py-0.5 rounded-full border font-medium transition ${active ? chipActive : chipBase}`}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
