import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * useUiPrefs — server-backed per-user UI preference bag.
 *
 * Reads/writes a shared JSON blob at `/api/me/ui-prefs`. Local
 * changes apply instantly (optimistic + localStorage cache) and are
 * flushed to the server on a short debounce so a rapid burst of
 * toggle clicks only fires one PATCH.
 *
 * Falls back gracefully:
 *   • no auth / offline → keeps working from localStorage only
 *   • server 5xx → keeps the optimistic value; next successful
 *                   flush wins (last-writer-wins is fine for UI prefs)
 *
 * Usage:
 *   const [prefs, patch] = useUiPrefs({ sidebar_collapsed: [] });
 *   patch({ sidebar_collapsed: [...] });   // instant local + debounced server
 *
 * The default is used exactly once — subsequent hook mounts read
 * from the cache (localStorage) then reconcile with the server load.
 */
const LS_KEY = "ishowedup_ui_prefs";
const FLUSH_DELAY_MS = 400;

// Process-wide singleton so multiple hook mounts share one in-flight
// server load + one debounce timer. Prevents thundering-herd on route
// changes.
let _cache = null;
let _serverLoaded = false;
let _inflightLoad = null;
const _subscribers = new Set();

function _readLS() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _writeLS(v) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(v)); } catch { /* quota */ }
}

function _notify() {
  for (const cb of _subscribers) cb(_cache);
}

async function _loadFromServer() {
  if (_serverLoaded) return _cache;
  if (_inflightLoad) return _inflightLoad;
  _inflightLoad = (async () => {
    try {
      const server = await api.get("/me/ui-prefs");
      // Server wins on load — it's the cross-device truth. If the user
      // hasn't ever saved prefs it'll be `{}` which is a safe no-op.
      _cache = { ..._cache, ...(server || {}) };
      _writeLS(_cache);
      _serverLoaded = true;
      _notify();
    } catch (e) {
      // Anonymous / offline / stale token — stick with localStorage.
      _serverLoaded = true;
    } finally {
      _inflightLoad = null;
    }
    return _cache;
  })();
  return _inflightLoad;
}

export function useUiPrefs(defaults = {}) {
  if (_cache === null) {
    // First-ever caller — hydrate from localStorage + apply defaults
    // for any keys the LS blob doesn't have yet.
    const ls = _readLS();
    _cache = { ...defaults, ...ls };
  }
  const [state, setState] = useState(_cache);
  const flushTimer = useRef(null);
  const pendingPatch = useRef({});

  useEffect(() => {
    const sub = (next) => setState({ ...next });
    _subscribers.add(sub);
    _loadFromServer();
    return () => { _subscribers.delete(sub); };
  }, []);

  const patch = useCallback((delta) => {
    // Optimistic apply — instant UI feedback.
    _cache = { ..._cache, ...delta };
    // Drop nulls so callers can un-remember a pref.
    for (const k of Object.keys(_cache)) if (_cache[k] === null) delete _cache[k];
    _writeLS(_cache);
    pendingPatch.current = { ...pendingPatch.current, ...delta };
    _notify();

    // Debounce the server PATCH so rapid clicks (e.g. flipping several
    // sidebar sections in quick succession) collapse into one round-trip.
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(async () => {
      const payload = pendingPatch.current;
      pendingPatch.current = {};
      flushTimer.current = null;
      try {
        await api.patch("/me/ui-prefs", payload);
      } catch { /* silent — LS keeps working; retry on next patch */ }
    }, FLUSH_DELAY_MS);
  }, []);

  return [state, patch];
}
