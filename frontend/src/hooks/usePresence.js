import { useEffect, useState, useCallback } from "react";
import { api } from "../api";
import { useAuth } from "../AuthContext";

/**
 * usePresence — heartbeats every 25 s from chef/admin sessions to the
 * server, and polls the online roster every 20 s so the presence chip
 * updates in near real-time without an extra websocket.
 *
 * Members with role != admin/chef are inert (no ping, no fetch) so
 * athletes/coaches never touch the endpoint.
 *
 * @param {string} where — free-form context tag ("Muster", "Pantry")
 * @returns {{online: Array<{id,name,role,photo,where}>}}
 */
export function usePresence(where) {
  const { user } = useAuth();
  const eligible = user && (user.role === "admin" || user.role === "chef");
  const [online, setOnline] = useState([]);

  const ping = useCallback(() => {
    if (!eligible) return;
    api.post("/presence/ping", { where }).catch(() => {});
  }, [eligible, where]);

  const fetchOnline = useCallback(() => {
    if (!eligible) return;
    api.get("/presence/online")
      .then((r) => setOnline(r.users || []))
      .catch(() => {});
  }, [eligible]);

  useEffect(() => {
    if (!eligible) return;
    ping();
    fetchOnline();
    const pingId = setInterval(ping, 25_000);
    const rosterId = setInterval(fetchOnline, 20_000);
    return () => { clearInterval(pingId); clearInterval(rosterId); };
  }, [eligible, ping, fetchOnline]);

  return { online };
}
