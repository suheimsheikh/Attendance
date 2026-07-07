/**
 * PhotoZoom — enlarged photo viewer used across Members + Presence.
 *
 * Shows the member's photo at its full quality on a dimmed backdrop.
 * When `onReplace` / `onRemove` are supplied, exposes those actions
 * as explicit footer buttons so hover-only "download/delete" chip
 * confusion goes away (7 Jul 2026 user complaint).
 *
 * Backdrop click, ESC, and the × button all close.
 */
import React, { useEffect } from "react";
import ReactDOM from "react-dom";
import { X, Camera, Trash2 } from "lucide-react";
import Avatar from "./Avatar";

export default function PhotoZoom({
  name,
  photo,
  subtitle,
  onClose,
  onReplace,   // optional: () => void — opens file-picker in parent
  onRemove,    // optional: () => void — removes the photo in parent
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[60] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
      data-testid="photo-zoom-backdrop"
    >
      <div
        className="relative bg-white rounded-2xl shadow-2xl ring-1 ring-slate-700/40 overflow-hidden max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
        data-testid="photo-zoom"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 z-10 w-9 h-9 rounded-full bg-white/90 hover:bg-white text-slate-700 flex items-center justify-center shadow ring-1 ring-slate-200"
          data-testid="photo-zoom-close"
        >
          <X size={16} />
        </button>

        {photo ? (
          <img
            src={photo}
            alt={name || "Photo"}
            className="block max-w-[80vw] max-h-[75vh] object-contain bg-slate-100"
            draggable={false}
          />
        ) : (
          <div className="flex items-center justify-center bg-slate-100" style={{ width: 360, height: 360 }}>
            <Avatar name={name} photo={null} size={220} />
          </div>
        )}

        <div className="px-4 py-3 border-t border-slate-100 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-extrabold tracking-tight text-slate-900 truncate">
              {name || "—"}
            </div>
            {subtitle && (
              <div className="text-xs text-slate-500 mt-0.5 truncate">{subtitle}</div>
            )}
          </div>
          {onReplace && (
            <button
              type="button"
              onClick={onReplace}
              className="iu-btn-secondary text-xs"
              data-testid="photo-zoom-replace"
            >
              <Camera size={13} />
              {photo ? "Replace" : "Add photo"}
            </button>
          )}
          {onRemove && photo && (
            <button
              type="button"
              onClick={onRemove}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold ring-1 ring-rose-200"
              data-testid="photo-zoom-remove"
            >
              <Trash2 size={13} />
              Remove
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
