import { useEffect, useRef } from "react";

// Shared registry of open modals so Esc only closes the TOP-most one,
// and typing inside an input is never thrown away (first Esc blurs the
// field, second Esc closes the modal).
const stack = [];
let listenerAttached = false;

function ensureListener() {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || stack.length === 0) return;
    const el = document.activeElement;
    const tag = el?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) {
      el.blur();
      return;
    }
    e.stopPropagation();
    stack[stack.length - 1].fire();
  });
}

/**
 * Bind the ESC key to call `onClose`. Use inside any modal/dialog that
 * should be dismissible by the keyboard without saving. With stacked
 * modals only the most recently opened one closes per Esc press.
 */
export function useEscape(onClose) {
  const cbRef = useRef(onClose);
  cbRef.current = onClose;
  const active = Boolean(onClose);
  useEffect(() => {
    if (!active) return undefined;
    ensureListener();
    const token = { fire: () => cbRef.current && cbRef.current() };
    stack.push(token);
    return () => {
      const i = stack.indexOf(token);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
