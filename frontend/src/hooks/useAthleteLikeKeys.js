import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * useAthleteLikeKeys — small memoised fetcher for the set of category
 * keys flagged `is_athlete_like=True` on the categories master. Both
 * seeded "athlete" and "elite" qualify; any admin-added athlete-like
 * custom category will also flow through here without a code change.
 *
 * Falls back to {athlete, elite} while the request is in flight or if
 * it fails so consumers get sensible defaults immediately without
 * flashing empty UI or losing Elite squad members.
 *
 * Result is process-cached: one API round-trip per full page load,
 * shared across every component that mounts the hook.
 */
let CACHED = null;
let INFLIGHT = null;

export function useAthleteLikeKeys() {
  const [keys, setKeys] = useState(() => CACHED || new Set(["athlete", "elite"]));
  useEffect(() => {
    if (CACHED) { setKeys(CACHED); return; }
    if (!INFLIGHT) {
      INFLIGHT = api.get("/masters/categories")
        .then((rows) => {
          const arr = Array.isArray(rows) ? rows : (rows?.items || []);
          const s = new Set(arr.filter((c) => c.is_athlete_like).map((c) => c.key));
          if (s.size > 0) CACHED = s;
        })
        .catch(() => { /* keep fallback */ })
        .finally(() => { INFLIGHT = null; });
    }
    INFLIGHT?.then(() => { if (CACHED) setKeys(CACHED); });
  }, []);
  return keys;
}
