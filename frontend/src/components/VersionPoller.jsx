import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { RefreshCw, X, AlertTriangle } from "lucide-react";

/**
 * VersionPoller — mounted once at the app root (inside <BrowserRouter>).
 *
 * Detects a new backend deploy via `GET /api/version` and, instead of
 * silently reloading, shows a BIG RED BANNER at the top of the app with a
 * "Refresh now" button. The user stays in control — nothing reloads until
 * they click. This replaced the earlier silent auto-reload (which was
 * surprising users and, in preview, firing on every hot-reload).
 *
 * How it works:
 *   1. On mount it remembers the version string reported at page load.
 *   2. Every 5 min it re-checks `/api/version`. The moment the string
 *      differs, it shows the banner.
 *   3. The banner has a "Refresh now" button (hard reload: unregisters the
 *      service worker + clears caches so no stale bundle survives) and a
 *      dismiss (×) that hides it until the NEXT version change.
 *
 * Silent on failures: if `/api/version` is missing (older backend) or the
 * network hiccups, the poller just keeps polling. Zero blast radius.
 */

const POLL_MS = 5 * 60_000; // 5 min — quiet, but responsive

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

export default function VersionPoller() {
  const initialVersion = useRef(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);
  // Version the user explicitly dismissed — so the banner stays hidden
  // for that version but re-appears if a newer one lands.
  const dismissedVersion = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      try {
        const res = await api.get("/version");
        const v = res && res.version;
        if (!v) return;
        if (initialVersion.current === null) {
          initialVersion.current = v;
          return;
        }
        if (v !== initialVersion.current && v !== dismissedVersion.current) {
          setUpdateAvailable(true);
        }
      } catch { /* silent */ }
    };
    check();
    const id = window.setInterval(check, POLL_MS);
    // Re-check the moment the user returns to the tab, so they see the
    // banner promptly instead of waiting up to 5 min.
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  const onRefresh = () => {
    setReloading(true);
    _hardReload();
  };
  const onDismiss = () => {
    // Remember the current latest version so we don't nag again for it.
    dismissedVersion.current = initialVersion.current;
    setUpdateAvailable(false);
  };

  if (!updateAvailable) return null;

  return (
    <div
      data-testid="version-update-banner"
      role="alert"
      className="fixed top-0 inset-x-0 z-[9999] bg-red-600 text-white shadow-lg animate-[slideDown_0.25s_ease-out]"
    >
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
        <AlertTriangle size={22} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-extrabold text-sm sm:text-base leading-tight">
            A new version of the app is available
          </p>
          <p className="text-red-100 text-xs sm:text-sm leading-tight">
            Refresh to get the latest features and fixes.
          </p>
        </div>
        <button
          type="button"
          data-testid="version-refresh-button"
          onClick={onRefresh}
          disabled={reloading}
          className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-white text-red-700 font-bold text-sm px-4 py-2 shadow hover:bg-red-50 active:scale-[0.98] transition disabled:opacity-70"
        >
          <RefreshCw size={16} className={reloading ? "animate-spin" : ""} />
          {reloading ? "Refreshing…" : "Refresh now"}
        </button>
        <button
          type="button"
          data-testid="version-banner-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="shrink-0 p-1.5 rounded-lg text-red-100 hover:text-white hover:bg-red-700/60 transition"
        >
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
