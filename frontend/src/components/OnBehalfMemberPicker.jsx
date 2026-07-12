/**
 * OnBehalfMemberPicker — the "File on behalf of" sky-tinted card
 * inside CorrectionRequestModal. Purely presentational — every piece
 * of state lives in the parent. Extracted 20 Feb 2026 as Phase 1 of
 * the "gradually reduce complexity" plan; behaviour is byte-identical
 * to the inline block that used to live at line 218.
 *
 * Two rendering modes:
 *   • `onBehalfOfMember` prop set        → locked pin (caller pre-selected)
 *   • else `onBehalfMember` derived      → clearable selection chip
 *   • else free-text search + result list
 */
import React from "react";
import { UserCog } from "lucide-react";

export default function OnBehalfMemberPicker({
  onBehalfOfMember,     // caller-locked target (immutable pin), or null
  onBehalfMember,       // currently-derived selection, or null
  memberQuery,          // controlled search input
  memberOptions,        // filtered member list
  onQueryChange,        // (str) => void
  onPick,               // (member) => void
  onClear,              // () => void
}) {
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-3" data-testid="correction-admin-onbehalf">
      <div className="flex items-center gap-2 mb-2">
        <UserCog size={16} className="text-sky-700" />
        <span className="text-xs font-semibold uppercase tracking-wide text-sky-900">
          File on behalf of
        </span>
      </div>
      {onBehalfOfMember ? (
        <div className="text-sm text-sky-900">
          <b>{onBehalfOfMember.full_name}</b>
          <span className="text-sky-700 text-xs ml-2">
            Applied instantly &mdash; no second approval needed.
          </span>
        </div>
      ) : (
        <>
          {onBehalfMember ? (
            <div className="flex items-center gap-2 text-sm text-sky-900">
              <span className="font-semibold">{onBehalfMember.full_name}</span>
              <button
                type="button"
                onClick={onClear}
                className="text-xs underline text-sky-700 hover:text-sky-900"
                data-testid="correction-onbehalf-clear"
              >
                Clear
              </button>
            </div>
          ) : (
            <>
              <input
                value={memberQuery}
                onChange={(e) => onQueryChange(e.target.value)}
                placeholder="Search member name (or leave empty to file for yourself)"
                className="iu-input text-sm"
                data-testid="correction-onbehalf-search"
              />
              {memberQuery.trim() && memberOptions.length > 0 && (
                <ul className="mt-1 max-h-40 overflow-y-auto bg-white border border-sky-200 rounded-lg divide-y">
                  {memberOptions.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => onPick(m)}
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-sky-50"
                        data-testid={`correction-onbehalf-pick-${m.id}`}
                      >
                        {m.full_name}
                        <span className="text-slate-400 text-xs ml-2">
                          {m.category}{m.role !== "member" ? ` · ${m.role}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p className="text-[11px] text-sky-700 mt-1.5">
            Leaving this empty files the request as your own. Filing on behalf of a member
            still requires a <b>different admin</b> to approve.
          </p>
        </>
      )}
    </div>
  );
}
