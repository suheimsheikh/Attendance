/**
 * MusterRow — one row in the Muster roster list.
 *
 * Purely presentational: all data comes in via props and all mutations
 * are surfaced as callbacks. No fetching, no toasts, no local state
 * (busy indicators come from the parent).
 *
 * Extracted from Muster.jsx on 15 Feb 2026 as part of the incremental
 * split of the 633-line parent (safest first refactor: JSX only,
 * zero state movement).
 *
 * Props:
 *   member                — one entry from /muster/athletes
 *   isPicked              — is this row currently selected for bulk save
 *   isLocked              — checkin mode + already_checked_in → non-tickable
 *   isAdmin               — admin sees the category chip and inline check-out
 *   singleCheckoutBusy    — this row's inline check-out request is in flight
 *   onToggle(id)          — tick/untick handler
 *   onAddPhoto(member)    — open the SelfieCapture flow for this member
 *   onInlineCheckout(m)   — close this member's open session directly
 *   categoryChipStyle     — { [category]: "bg-... text-..." } map
 */
import React from "react";
import { CheckSquare, Camera, Loader2, LogOut as LogOutIcon } from "lucide-react";
import Avatar from "../../components/Avatar";
import ParentContact from "../../components/ParentContact";

export default function MusterRow({
  member: s,
  isPicked,
  isLocked,
  isAdmin,
  singleCheckoutBusy,
  onToggle,
  onAddPhoto,
  onInlineCheckout,
  categoryChipStyle,
}) {
  const inAt = s.check_in_at
    ? new Date(s.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })
    : null;

  return (
    <li
      onClick={() => onToggle(s.id)}
      className={`flex items-center gap-3 px-4 py-3 transition ${
        isLocked
          ? "bg-slate-100 text-slate-500 cursor-not-allowed"
          : isPicked
            ? "bg-emerald-50 cursor-pointer"
            : "hover:bg-slate-50 cursor-pointer"
      }`}
      data-testid={`muster-row-${s.id}`}
      aria-disabled={isLocked || undefined}
    >
      <div
        className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
          isLocked
            ? "bg-slate-200 border-slate-300 text-slate-400"
            : isPicked
              ? "bg-emerald-600 border-emerald-600 text-white"
              : "border-slate-300"
        }`}
        data-testid={`muster-checkbox-${s.id}`}
      >
        {(isPicked || isLocked) && <CheckSquare size={14} />}
      </div>
      <Avatar name={s.full_name} photo={s.photo} size={48} ring={isPicked ? "#10B981" : null} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="font-semibold text-slate-900 truncate flex-1">{s.full_name}</div>
          {isAdmin && s.category && s.category !== "athlete" && (
            <span
              title={`Category: ${s.category}`}
              data-testid={`muster-category-chip-${s.id}`}
              className={`inline-flex items-center px-1.5 h-5 rounded text-[10px] font-bold shrink-0 capitalize ${categoryChipStyle[s.category] || "bg-slate-100 text-slate-700"}`}
            >
              {s.category}
            </span>
          )}
          {isLocked && (
            <span
              title={inAt ? `Checked in at ${inAt}` : "Already checked in"}
              data-testid={`muster-already-in-${s.id}`}
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold bg-slate-200 text-slate-600 shrink-0"
            >
              ✓ {inAt ? `In · ${inAt}` : "Already in"}
            </span>
          )}
          {s.institution && (
            <span
              title={`Institution: ${s.institution}`}
              data-testid={`muster-institution-chip-${s.id}`}
              className="inline-flex items-center px-1.5 h-5 rounded text-[10px] font-bold bg-sky-100 text-sky-700 shrink-0 max-w-[110px] truncate"
            >
              {s.institution}
            </span>
          )}
          <ParentContact father={s.father_mobile} mother={s.mother_mobile} guardian={s.guardian_mobile} />
        </div>
        {s.rank && (
          <div className="text-xs text-slate-500 truncate">{s.rank}</div>
        )}
      </div>
      {!s.photo && !isLocked && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAddPhoto(s); }}
          className="ml-2 inline-flex items-center gap-1 px-2 h-7 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold hover:bg-amber-200 shrink-0"
          data-testid={`muster-photo-${s.id}`}
        >
          <Camera size={11} /> Add photo
        </button>
      )}
      {/* Inline check-out on already-in rows — lets admins close a stale
          open session directly from the check-in view without switching
          modes. Admin-only: coaches/escorts still see the "In · HH:MM"
          chip as read-only. */}
      {isLocked && isAdmin && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onInlineCheckout(s); }}
          disabled={singleCheckoutBusy}
          className="ml-2 inline-flex items-center gap-1 px-2 h-7 rounded-full bg-slate-800 text-white text-[11px] font-bold hover:bg-slate-900 shrink-0 cursor-pointer disabled:opacity-60"
          data-testid={`muster-inline-checkout-${s.id}`}
          title="Check this member out now"
        >
          {singleCheckoutBusy
            ? <Loader2 size={11} className="animate-spin" />
            : <LogOutIcon size={11} />} Check out
        </button>
      )}
    </li>
  );
}
