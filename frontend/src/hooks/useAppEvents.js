/**
 * useAppEvents — app-wide live updates over SSE (GET /api/events).
 * The server bumps a signal whenever corrections/approvals change; we
 * invalidate just those React Query keys so badges, banners and the
 * Approvals table refresh inline — no page reload, no 60 s polling.
 * Signals from THIS tab (same CLIENT_ID) are ignored.
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CLIENT_ID, getToken } from "../api";

const BASE = process.env.REACT_APP_BACKEND_URL;
const KEYS = ["/admin/approvals-summary", "/me/corrections", "/admin/corrections", "/admin/corrections/pending-for-me"];

export function useAppEvents(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    const token = getToken();
    if (!enabled || !token || typeof EventSource === "undefined") return;
    let baseline = null;
    const es = new EventSource(`${BASE}/api/events?token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      let d;
      try { d = JSON.parse(ev.data); } catch { return; }
      if (typeof d?.seq !== "number") return;
      if (baseline === null) { baseline = d.seq; return; }
      if (d.seq <= baseline) return;
      const jumped = d.seq - baseline > 1;
      baseline = d.seq;
      if (!jumped && d.client && d.client === CLIENT_ID) return;
      KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    };
    return () => es.close();
  }, [enabled, qc]);
}
