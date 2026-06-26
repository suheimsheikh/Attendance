import React from "react";
import { AlertCircle, X } from "lucide-react";

/**
 * FormErrorBanner — drop-in inline error block for Save / Submit actions.
 *
 * Renders a red banner above the form's primary action so the failure
 * stays visible right where the user clicked, instead of as a top-of-screen
 * toast that fades out (sonner default = 4s) before they can read it.
 *
 * Use together with the `useFormError` hook (./useFormError.js) — the hook
 * owns the state and the api-error → message translation; this component
 * just renders.
 *
 * Props:
 *  - error:        string | null   message to render; null hides the banner.
 *  - requestId:    string | null   optional X-Request-ID from the failed API
 *                                  call — shown small underneath so support
 *                                  can grep server logs straight to the line.
 *  - onDismiss:    () => void      optional close handler (X button).
 *  - testId:       string          override the data-testid (default "form-error-banner").
 */
export default function FormErrorBanner({ error, requestId = null, onDismiss = null, testId = "form-error-banner" }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 flex items-start gap-2 mb-3 animate-in fade-in slide-in-from-top-1"
    >
      <AlertCircle size={16} className="text-red-600 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 text-xs leading-snug text-red-800">
        <div className="font-semibold whitespace-pre-wrap break-words" data-testid={`${testId}-message`}>{error}</div>
        {requestId && (
          <div className="text-[10px] opacity-70 mt-0.5 font-mono" data-testid={`${testId}-request-id`}>
            Request ID: {requestId}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          data-testid={`${testId}-dismiss`}
          className="p-1 -m-1 text-red-600 hover:text-red-800 hover:bg-red-100 rounded transition"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
