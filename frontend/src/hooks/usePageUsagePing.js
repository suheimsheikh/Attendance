import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";

// Throttle map (module-scope so it survives re-mounts within a session):
// feature path -> last ping epoch ms. We only ping a given page once per
// window to avoid spamming Mongo when a user bounces between screens.
const lastPinged = new Map();
const THROTTLE_MS = 5 * 60 * 1000; // 5 minutes per path per session

/** Fire a lightweight, fire-and-forget usage ping on every route change.
 * Powers the super-admin Feature Usage & Ageing dashboard. Failures are
 * swallowed — this must never disrupt navigation. */
export function usePageUsagePing() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (!pathname) return;
    const now = Date.now();
    const prev = lastPinged.get(pathname) || 0;
    if (now - prev < THROTTLE_MS) return;
    lastPinged.set(pathname, now);
    api.post("/usage/ping", { path: pathname }).catch(() => {});
  }, [pathname]);
}
