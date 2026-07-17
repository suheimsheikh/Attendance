/**
 * MissingPhotoStrip — the amber alert bar on the Presence page that
 * lists athletes currently on campus without a profile photo. Tapping
 * it kicks off a queued photo-capture flow (SelfieCapture on the
 * parent). Purely presentational — parent owns the click handler and
 * the underlying photo queue.
 *
 * Extracted 14 Feb 2026 (item C of the low-risk refactor pass).
 */
import React from "react";
import { Camera } from "lucide-react";

export default function MissingPhotoStrip({ members, onStart }) {
  if (!members || members.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => onStart(members)}
      data-testid="presence-missing-photos-strip"
      className="w-full mb-3 iu-card px-4 py-2.5 flex items-center gap-3 text-left hover:bg-amber-50 transition group"
    >
      <span className="w-9 h-9 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center ring-1 ring-amber-200">
        <Camera size={16} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-800">
          {members.length} athlete{members.length === 1 ? "" : "s"} on campus without a photo
        </div>
        <div className="text-xs text-slate-500 truncate">
          Tap to capture photos while they&apos;re here — skip any time.
          {" "}
          {members.slice(0, 3).map((m) => m.full_name).join(", ")}
          {members.length > 3 && ` +${members.length - 3} more`}
        </div>
      </div>
      <span className="text-[10px] uppercase tracking-wider font-bold text-amber-700 group-hover:underline">
        Capture
      </span>
    </button>
  );
}
