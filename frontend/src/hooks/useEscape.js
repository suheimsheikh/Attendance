import { useEffect } from "react";

/**
 * Bind the ESC key to call `onClose`. Use inside any modal/dialog that
 * should be dismissible by the keyboard without saving.
 */
export function useEscape(onClose) {
  useEffect(() => {
    if (!onClose) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
}
