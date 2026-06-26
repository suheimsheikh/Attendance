import { useCallback, useState } from "react";

/**
 * useFormError — tiny hook for inline-error UX on Save / Submit actions.
 *
 * Why a hook? Forms used to surface failures as a top-of-screen toast
 * (sonner), which fades after ~4s and is easy to miss when the user is
 * looking at the Save button. We now render a red banner directly above
 * the action (see <FormErrorBanner />) — this hook owns the state and
 * the api-error → message translation so each form doesn't reinvent it.
 *
 * Usage:
 *   const formErr = useFormError();
 *
 *   const onSave = async () => {
 *     formErr.clear();
 *     try { await api.post(...); }
 *     catch (err) { formErr.setFromApi(err, "Failed to save"); }
 *   };
 *
 *   return <form>
 *     ...
 *     <FormErrorBanner
 *       error={formErr.error}
 *       requestId={formErr.requestId}
 *       onDismiss={formErr.clear}
 *     />
 *     <button onClick={onSave}>Save</button>
 *   </form>;
 *
 * Notes:
 *  - `setFromApi(err, fallback)` reads `err.message` + `err.requestId`
 *    (set by api.js → ApiError). It does NOT fire a toast — the banner
 *    is now the single source of truth for save/submit failures.
 *  - For non-save actions (downloads, list loads, deletes triggered by
 *    a row icon etc.) keep using `showApiError` / `toast.error`.
 */
export function useFormError() {
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(null);

  const clear = useCallback(() => {
    setError(null);
    setRequestId(null);
  }, []);

  const setMessage = useCallback((msg) => {
    setError(msg || null);
    setRequestId(null);
  }, []);

  const setFromApi = useCallback((err, fallback = "Something went wrong") => {
    const msg = err?.message || fallback;
    setError(msg);
    setRequestId(err?.requestId || null);
  }, []);

  return { error, requestId, clear, setMessage, setFromApi };
}
