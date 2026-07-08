/**
 * useGeoPermission — reactive Geolocation permission state.
 *
 * Returns 'granted' | 'prompt' | 'denied' | 'unsupported'. Uses the
 * Permissions API where available; on older browsers (Safari <16 on
 * iOS) `navigator.permissions` doesn't ship a "geolocation" entry, so
 * we return "unsupported" and the calling code should just let the
 * native permission prompt happen when the check-in button is pressed.
 *
 * Reactive: subscribes to `permissionStatus.change` events so the UI
 * updates the moment the user grants or revokes location.
 */
import { useEffect, useState } from "react";

export function useGeoPermission() {
  const [state, setState] = useState(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return "unsupported";
    return "prompt";   // pessimistic default until the API confirms
  });

  useEffect(() => {
    let cancelled = false;
    let permStatus = null;

    if (!navigator.geolocation) {
      setState("unsupported");
      return;
    }
    if (!navigator.permissions?.query) {
      // API not available (older Safari). Leave state as "prompt" —
      // caller will trigger the native prompt when needed.
      return;
    }

    (async () => {
      try {
        permStatus = await navigator.permissions.query({ name: "geolocation" });
        if (cancelled) return;
        setState(permStatus.state);
        permStatus.addEventListener?.("change", () => {
          if (!cancelled) setState(permStatus.state);
        });
      } catch (err) {
        // Some browsers throw when name is unknown — treat as unsupported.
        console.debug("permissions.query(geolocation) failed:", err?.message);
        setState("unsupported");
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return state;
}
