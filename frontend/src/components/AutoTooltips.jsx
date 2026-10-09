import { useEffect } from "react";

// App-wide hover hints (Oct 2026): any icon-only button/link with no `title`
// gets one from its aria-label, or from its data-testid in plain words
// ("edit-member-<id>" → "Edit member"). Elements with text or a title are untouched.
const ID_LIKE = /^(?=.*\d)[0-9a-f-]{6,}$|^\d+$/i;

export function hintFromTestId(tid) {
  const words = (tid || "").split(/[-_]/).filter((w) => w && !ID_LIKE.test(w) && w.length < 20);
  const drop = new Set(["btn", "button", "link", "icon", "inline"]);
  const text = words.filter((w) => !drop.has(w.toLowerCase())).join(" ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

function label(el) {
  if (el.title || el.getAttribute("data-no-hint") != null) return;
  if ((el.textContent || "").trim()) return;
  const hint = el.getAttribute("aria-label") || hintFromTestId(el.getAttribute("data-testid"));
  if (hint) el.title = hint;
}

const scan = (root) => {
  if (root.nodeType !== 1) return;
  if (root.matches?.("button, a, [role=button]")) label(root);
  root.querySelectorAll?.("button, a, [role=button]").forEach(label);
};

export default function AutoTooltips() {
  useEffect(() => {
    scan(document.body);
    let queued = [];
    let raf = 0;
    const obs = new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => queued.push(n)));
      if (!raf) raf = requestAnimationFrame(() => { queued.forEach(scan); queued = []; raf = 0; });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => { obs.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  return null;
}
