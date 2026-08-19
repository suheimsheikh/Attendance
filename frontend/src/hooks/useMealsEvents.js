/**
 * useMealsEvents — subscribes to the pantry live-update SSE stream
 * (GET /api/meals/events). The server pushes a signal whenever ANY
 * machine changes pantry data (purchases / issues / wastage / items /
 * vendors / categories); we call `onSignal({seq, scope, date, client})`
 * so the caller can refetch just the affected data.
 *
 * Behaviour:
 *  • First frame on connect is the current seq — used purely as a
 *    baseline (the mounting component just fetched fresh data anyway).
 *  • EventSource auto-reconnects; on reconnect the server re-emits the
 *    current seq, so anything missed while disconnected still triggers
 *    exactly one refetch.
 *  • Signals originated by THIS browser tab (matching CLIENT_ID) are
 *    ignored — the tab already has its own data.
 */
import { useEffect, useRef } from "react";
import { CLIENT_ID, getToken } from "../api";

const BASE = process.env.REACT_APP_BACKEND_URL;

export function useMealsEvents(onSignal) {
  const cb = useRef(onSignal);
  useEffect(() => { cb.current = onSignal; });

  useEffect(() => {
    const token = getToken();
    if (!token || typeof EventSource === "undefined") return;
    let baseline = null;
    const es = new EventSource(
      `${BASE}/api/meals/events?token=${encodeURIComponent(token)}`
    );
    es.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (typeof d?.seq !== "number") return;
      if (baseline === null) { baseline = d.seq; return; }
      if (d.seq <= baseline) return;
      baseline = d.seq;
      if (d.client && d.client === CLIENT_ID) return; // our own echo
      cb.current?.(d);
    };
    return () => es.close();
  }, []);
}

/** True while the user is actively typing in a form control — used to
 * defer a live refresh so it never clobbers an in-progress edit. */
export function isUserEditing() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
