/**
 * usePublicPresenceToast — polls /api/presence/public every ~20s and
 * fires a toast when a NEW chef/admin appears online (Feb 2026 user
 * request: "Show 'Priya just came online' on the login page so chefs
 * know they've got backup arriving").
 *
 * Only surfaces new arrivals (baselined on first tick so mounting the
 * page mid-shift doesn't spam every currently-online user).
 */
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "../api";

export function usePublicPresenceToast({ enabled = true, intervalMs = 20_000 } = {}) {
  const seen = useRef(null);   // Set of "firstName|role" or null on first tick

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get("/presence/public");
        if (cancelled) return;
        const users = res?.users || [];
        const keys = new Set(users.map((u) => `${u.first_name}|${u.role}`));
        if (seen.current === null) {
          // First fetch — baseline silently.
          seen.current = keys;
          return;
        }
        for (const u of users) {
          const k = `${u.first_name}|${u.role}`;
          // "New" = wasn't in the previous roster AND was seen within
          // the last ~90s (so a stale-cache appearance doesn't spam).
          if (!seen.current.has(k) && (u.age_seconds ?? 999) <= 90) {
            const roleLabel = u.role === "chef" ? "chef" : u.role === "admin" ? "admin" : "";
            toast.success(`${u.first_name}${roleLabel ? ` (${roleLabel})` : ""} just came online`, {
              icon: "👋", duration: 5000,
            });
          }
        }
        seen.current = keys;
      } catch { /* poll swallows errors silently */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, intervalMs]);
}
