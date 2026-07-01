import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import React from "react";
import { api } from "../api";

/**
 * VersionPoller — mounted once at the app root (App.js).
 *
 * Polls `GET /api/version` every 30 minutes while the tab is visible.
 * When the value differs from the version recorded on first successful
 * poll, we show a persistent Sonner toast asking the user to refresh.
 * The Refresh button:
 *   1. Unregisters every service worker (kills stale caching layers).
 *   2. Clears all Cache Storage entries.
 *   3. Reloads the page with `location.reload()` so the fresh
 *      index.html loads the new fingerprinted JS bundles.
 *
 * Deliberately silent on failures: if `/api/version` is missing (older
 * backend) or the network hiccups, we just keep polling. Zero blast
 * radius — the toast never appears when the endpoint disagrees or
 * doesn't exist.
 *
 * The toast is fired at most once per session — once shown, we stop
 * polling. The user either refreshes (page reload restarts polling with
 * the fresh version) or dismisses it and gets on with their day.
 */
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
  window.location.reload();
}

function _showRefreshToast() {
  toast.custom(
    (t) => (
      <div
        className="rounded-xl border border-emerald-200 bg-white shadow-lg px-4 py-3 flex items-start gap-3 max-w-sm"
        data-testid="new-version-toast"
      >
        <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
          <RefreshCw size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900">New version available</div>
          <div className="text-xs text-slate-500 mt-0.5">
            iShowedUp has been updated. Refresh to load the latest features.
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={_hardReload}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
              data-testid="new-version-refresh-btn"
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              type="button"
              onClick={() => toast.dismiss(t)}
              className="px-2 py-1 rounded-md text-slate-500 hover:text-slate-800 text-xs"
              data-testid="new-version-dismiss-btn"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    ),
    { duration: Infinity, position: "top-center" },
  );
}

export default function VersionPoller() {
  // Store the first-observed version and whether we've already
  // notified. Refs (not state) because we don't want the toast lifecycle
  // to re-trigger a render cascade.
  const initialVersion = useRef(null);
  const notified = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    // Poll every 30 minutes. Aggressive polling isn't necessary — a
    // deploy that lands mid-shift can wait a bit for members to be
    // told; we care far more about surfacing stale bundles WITHIN THE
    // SAME DAY than in the same minute. The visibility-gate below
    // also skips ticks while the tab is hidden.
    const POLL_MS = 30 * 60_000;

    const check = async () => {
      if (notified.current) return;
      // Skip when the tab is hidden — no point burning bytes on a
      // backgrounded PWA.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await api.get("/version");
        const v = (res && res.version) || null;
        if (!v) return;
        if (initialVersion.current === null) {
          initialVersion.current = v;
          return;
        }
        if (v !== initialVersion.current && !notified.current) {
          notified.current = true;
          _showRefreshToast();
          if (timerRef.current) window.clearInterval(timerRef.current);
        }
      } catch {
        // Silent — endpoint may be missing on older backends, or the
        // network may have blipped. Try again on the next tick.
      }
    };

    // Fire once immediately so we cache the initial version, then
    // start the interval.
    check();
    timerRef.current = window.setInterval(check, POLL_MS);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  return null;
}
