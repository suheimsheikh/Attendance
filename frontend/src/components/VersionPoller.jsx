import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";

/**
 * VersionPoller — mounted once at the app root (inside <BrowserRouter>).
 *
 * Detects a new backend deploy via `GET /api/version` and silently
 * reloads the page at the next SAFE moment so end-users never sit on a
 * stale JS bundle. No toast, no button, no interruption.
 *
 * ------------------------------------------------------------------
 * Why "safe moment" instead of just calling `location.reload()`?
 * ------------------------------------------------------------------
 * A `<React state>` reload wipes any unsaved form data (leave apps,
 * corrections, member edits, in-flight check-ins). Force-reloading
 * mid-typing is the same class of hostile UX as a browser popup
 * during a Slack DM. Instead we watch for these safe triggers, and
 * fire the reload on the first that occurs:
 *
 *   1. **Tab visibility → visible**  — the user just switched back to
 *      the tab, so they weren't editing here. Silent reload.
 *   2. **Route change**  — the user is done with the current page,
 *      about to render a new one. Silent reload before the next
 *      render kicks in (Gmail does exactly this).
 *   3. **Idle timeout**  — no keyboard/mouse/touch input for 3 min.
 *      Safe to assume they walked away.
 *   4. **Hard fallback**  — 30 min after we detected the new
 *      version, reload regardless. Guarantees no user sits on a
 *      stale bundle for hours.
 *
 * Extra safety: right before reloading, we sniff `document.activeElement`.
 * If the user has an <input>, <textarea>, or contentEditable focused, we
 * skip THIS trigger and wait for the next one. The 30-min fallback
 * ignores this guard so we're never fully stuck.
 *
 * Silent on failures: if `/api/version` is missing (older backend) or
 * network hiccups, the poller just keeps polling. Zero blast radius.
 */

const POLL_MS = 5 * 60_000;          // 5 min — quiet, but responsive
const IDLE_MS = 3 * 60_000;          // 3 min of no input
const HARD_FALLBACK_MS = 30 * 60_000;  // 30 min after detection

async function _hardReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    }
  } catch { /* ignore */ }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    }
  } catch { /* ignore */ }
  // Cache-bust the HTML request itself — some CDNs are stubborn.
  window.location.reload();
}

function _hasActiveEdit() {
  const el = typeof document !== "undefined" && document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (el.isContentEditable) return true;
  return false;
}

export default function VersionPoller() {
  const initialVersion = useRef(null);
  const staleDetectedAt = useRef(null);
  const reloadingRef = useRef(false);
  const location = useLocation();

  // ------------------------------------------------------------------
  // 1. Polling — memoise initial version, watch for drift.
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (cancelled || staleDetectedAt.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await api.get("/version");
        const v = res && res.version;
        if (!v) return;
        if (initialVersion.current === null) {
          initialVersion.current = v;
          return;
        }
        if (v !== initialVersion.current) {
          staleDetectedAt.current = Date.now();
        }
      } catch { /* silent */ }
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // ------------------------------------------------------------------
  // 2. Triggers — reload on the first safe signal after drift.
  // ------------------------------------------------------------------
  useEffect(() => {
    const tryReload = (reason, { ignoreActiveEdit = false } = {}) => {
      if (reloadingRef.current) return;
      if (!staleDetectedAt.current) return;
      if (!ignoreActiveEdit && _hasActiveEdit()) return;
      reloadingRef.current = true;
      console.debug(`[VersionPoller] silent auto-reload → ${reason}`);
      _hardReload();
    };

    // 2a. Tab becomes visible again.
    const onVis = () => {
      if (document.visibilityState === "visible") tryReload("visibility");
    };
    document.addEventListener("visibilitychange", onVis);

    // 2b. Idle timer — resets on any user input.
    let idleTimer = window.setTimeout(() => tryReload("idle"), IDLE_MS);
    const resetIdle = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => tryReload("idle"), IDLE_MS);
    };
    ["mousemove", "keydown", "touchstart", "click", "wheel"].forEach((evt) => {
      window.addEventListener(evt, resetIdle, { passive: true });
    });

    // 2c. Hard fallback — ignores active-edit guard so we NEVER get
    // permanently stuck (e.g. user leaves cursor in an input all day).
    const fallbackTimer = window.setInterval(() => {
      if (!staleDetectedAt.current) return;
      const age = Date.now() - staleDetectedAt.current;
      if (age >= HARD_FALLBACK_MS) tryReload("hard-fallback", { ignoreActiveEdit: true });
    }, 60_000);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      ["mousemove", "keydown", "touchstart", "click", "wheel"].forEach((evt) => {
        window.removeEventListener(evt, resetIdle);
      });
      window.clearTimeout(idleTimer);
      window.clearInterval(fallbackTimer);
    };
  }, []);

  // ------------------------------------------------------------------
  // 3. Route-change trigger — fires whenever `useLocation` updates.
  //    Deliberately in its own effect (dependency = location) so it
  //    doesn't re-register the visibility/idle listeners on every nav.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!staleDetectedAt.current) return;
    if (reloadingRef.current) return;
    if (_hasActiveEdit()) return;
    reloadingRef.current = true;
    console.debug("[VersionPoller] silent auto-reload → route-change");
    _hardReload();
  }, [location.pathname]);

  return null;
}
