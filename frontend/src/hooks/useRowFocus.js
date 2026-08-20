import { useEffect, useRef, useState, useCallback } from "react";
import { api } from "../api";

/**
 * useRowFocus — tracks WHICH row each peer chef is currently editing
 * on Daily Entry, plus lets us broadcast our own focus / blur events.
 *
 * On focus of an editable cell we POST /api/meals/focus with the
 * (scope, date, item_id) triple; on blur we POST action=blur. The
 * server keeps a 15-second TTL map and bumps the meals SSE channel
 * so peer clients pull the fresh map via /api/meals/focus?date=…
 *
 * Zero DB writes, ~100 bytes per event, ~5-10 events per user per
 * bulk-entry session — bandwidth is a non-issue.
 *
 * @param {string} dateStr — yyyy-mm-dd of the day being edited
 * @param {object} liveSig — the useMealsEvents signal (bumped by SSE)
 * @returns {{focusMap: Map<string,{scope,user_id,name}>, notifyFocus, notifyBlur}}
 */
export function useRowFocus(dateStr, liveSig) {
  // Key = `${scope}:${item_id}`. Value = { scope, user_id, name }.
  const [focusMap, setFocusMap] = useState(() => new Map());
  const currentlyOwnRef = useRef(new Set()); // keys we hold locally, for blur-on-unmount

  const refresh = useCallback(() => {
    if (!dateStr) return;
    api.get(`/meals/focus`, { date: dateStr })
      .then((r) => {
        const m = new Map();
        for (const row of r.focus || []) {
          m.set(`${row.scope}:${row.item_id}`, row);
        }
        setFocusMap(m);
      })
      .catch(() => {});
  }, [dateStr]);

  // Initial hydrate + refresh on any 'focus' SSE broadcast (or any
  // meals broadcast — cheap enough).
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!liveSig) return;
    if (liveSig.scope === "focus" || liveSig.scope === "*") refresh();
  }, [liveSig, refresh]);

  const notifyFocus = useCallback((scope, itemId) => {
    if (!dateStr) return;
    const key = `${scope}:${itemId}`;
    currentlyOwnRef.current.add(key);
    api.post("/meals/focus", { scope, date: dateStr, item_id: itemId, action: "focus" }).catch(() => {});
  }, [dateStr]);

  const notifyBlur = useCallback((scope, itemId) => {
    if (!dateStr) return;
    const key = `${scope}:${itemId}`;
    currentlyOwnRef.current.delete(key);
    api.post("/meals/focus", { scope, date: dateStr, item_id: itemId, action: "blur" }).catch(() => {});
  }, [dateStr]);

  // Best-effort blur every cell we still hold on unmount / day-change
  // so peer chefs don't see a stale "still editing" chip.
  useEffect(() => {
    return () => {
      for (const key of currentlyOwnRef.current) {
        const [scope, itemId] = key.split(":");
        api.post("/meals/focus", { scope, date: dateStr, item_id: itemId, action: "blur" }).catch(() => {});
      }
      currentlyOwnRef.current.clear();
    };
  }, [dateStr]);

  return { focusMap, notifyFocus, notifyBlur };
}
