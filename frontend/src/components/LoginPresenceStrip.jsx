/**
 * LoginPresenceStrip — a small "who's on shift right now" pill under
 * the login form (Feb 2026 user request). Lists first names of chefs/
 * admins currently online. No PII beyond first name + role.
 *
 * Paired with usePublicPresenceToast for live "just came online"
 * notifications.
 */
import React, { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { api } from "../api";

function shortAgo(sec) {
  if (sec == null) return "";
  if (sec < 60) return "just now";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export default function LoginPresenceStrip({ intervalMs = 20_000 }) {
  const [users, setUsers] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.get("/presence/public");
        if (cancelled) return;
        setUsers(res?.users || []);
      } catch { /* silent — public endpoint, ok to fail */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [intervalMs]);

  if (!users.length) return null;

  return (
    <div
      className="mt-6 p-3 rounded-xl bg-emerald-50 ring-1 ring-emerald-200 flex items-start gap-2.5"
      data-testid="login-presence-strip"
    >
      <div className="mt-0.5 w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
        <Users size={16}/>
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-800 flex items-center gap-1.5">
          <span className="inline-flex w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"/>
          On shift now · {users.length}
        </div>
        <div className="mt-0.5 text-xs text-slate-700 leading-snug">
          {users.slice(0, 5).map((u, i) => (
            <span key={`${u.first_name}-${i}`} data-testid={`login-presence-name-${i}`}>
              <b className="text-slate-900">{u.first_name}</b>
              <span className="text-slate-500"> ({u.role}, {shortAgo(u.age_seconds)})</span>
              {i < Math.min(users.length, 5) - 1 && <span className="text-slate-400">, </span>}
            </span>
          ))}
          {users.length > 5 && <span className="text-slate-500"> +{users.length - 5} more</span>}
        </div>
      </div>
    </div>
  );
}
