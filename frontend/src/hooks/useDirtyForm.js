import { useCallback, useEffect, useRef, useState } from "react";
import { useEscape } from "./useEscape";

/**
 * useDirtyForm — snapshot `form` on mount, report `dirty` whenever it
 * changes, and wrap `onClose` so Esc / backdrop / X ask before discarding
 * unsaved edits. Call `markSaved()` right after a successful save.
 */
export function useDirtyForm(form, onClose) {
  const snap = useRef(null);
  const [, bump] = useState(0);
  if (snap.current === null) snap.current = JSON.stringify(form);
  const dirty = JSON.stringify(form) !== snap.current;

  const close = useCallback(() => {
    if (dirty && !window.confirm("You have unsaved changes. Discard them?")) return;
    onClose?.();
  }, [dirty, onClose]);
  useEscape(onClose ? close : null);

  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const markSaved = useCallback(() => { snap.current = JSON.stringify(form); bump((n) => n + 1); }, [form]);
  return { dirty, close, markSaved };
}
