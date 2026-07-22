/**
 * ExMemberToggle — the "Show ex-members" checkbox/pill shown at the
 * top of Members / Presence / Muster / Reports Attendance surfaces.
 * Default OFF (i.e. ex-members hidden). Persists preference in
 * localStorage per-surface so an admin who wants to see ex-members on
 * one page doesn't have to keep re-clicking.
 */
import React from "react";
import { UserX } from "lucide-react";

/** Convenience hook that also persists to localStorage. */
export function useExMemberToggle(surfaceKey, initial = false) {
  const storageKey = `show_ex_members_${surfaceKey}`;
  const [showEx, setShowEx] = React.useState(() => {
    try { return localStorage.getItem(storageKey) === "1"; }
    catch { return initial; }
  });
  const set = React.useCallback((v) => {
    setShowEx(v);
    try { localStorage.setItem(storageKey, v ? "1" : "0"); }
    catch { /* ignore */ }
  }, [storageKey]);
  return [showEx, set];
}

export default function ExMemberToggle({ showEx, onChange, exCount, className = "" }) {
  return (
    <button
      type="button"
      data-testid="ex-member-toggle"
      onClick={() => onChange(!showEx)}
      className={`iu-chip ${showEx ? "iu-chip-active" : ""} ${className}`}
      title={showEx ? "Hide members who have left" : "Show members who have left"}
    >
      <UserX size={12}/> {showEx ? "Showing" : "Show"} ex-members
      {typeof exCount === "number" && exCount > 0 && (
        <span className={`min-w-[18px] h-4 px-1 rounded text-[9px] font-bold flex items-center justify-center ${showEx ? "bg-white/20" : "bg-slate-100 text-slate-500 border border-slate-300"}`}>
          {exCount}
        </span>
      )}
    </button>
  );
}
