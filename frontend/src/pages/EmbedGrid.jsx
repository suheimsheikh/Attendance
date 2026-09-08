import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, ShieldAlert, Lock } from "lucide-react";
import { useAuth } from "../auth";
import Reports from "./admin/Reports";

/**
 * Chrome-less FULL Grid embed for PayCraft.
 *
 * Renders the exact portal Reports UI (Calendar Grid / Attendance /
 * Daily Leave-Tour tabs, filters, CSV/PDF, double-click-to-edit,
 * corrections, month-lock) with no sidebar/nav and no login prompt.
 *
 * Auth: the page reads the embed secret (?key=) once, scrubs it from the
 * URL, then exchanges it via the `X-Embed-Key` header on GET
 * /api/embed/auth for a short-lived portal admin session
 *
 * Confirmed 30 Jun 2026 with the owner: full-admin scope, shown only to
 * trusted internal PayCraft admins.
 */
export default function EmbedGrid() {
  const [params] = useSearchParams();
  const key = params.get("key") || "";
  const { loginWithToken } = useAuth();
  const [status, setStatus] = useState(key ? "loading" : "missing");

  useEffect(() => {
    if (!key) return;
    const base = process.env.REACT_APP_BACKEND_URL;
    let alive = true;
    // Scrub the secret from the address bar / history as soon as it's read.
    window.history.replaceState(null, "", window.location.pathname);
    fetch(`${base}/api/embed/auth`, { headers: { "X-Embed-Key": key } })
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401) return setStatus("denied");
        if (r.status === 503) return setStatus("unconfigured");
        if (!r.ok) return setStatus("error");
        const data = await r.json();
        loginWithToken(data.access_token, data.user);
        setStatus("ready");
      })
      .catch(() => alive && setStatus("network"));
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === "ready") {
    return (
      <div className="min-h-screen bg-slate-50" data-testid="embed-grid-full">
        <Reports />
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50" data-testid="embed-grid-loading">
        <Loader2 className="animate-spin text-slate-400" size={26} />
      </div>
    );
  }

  const msg = {
    missing: { icon: <Lock size={28} />, title: "Access key required", sub: "Add ?key=… to embed the grid." },
    denied: { icon: <ShieldAlert size={28} />, title: "Access denied", sub: "The embed key is invalid." },
    unconfigured: { icon: <ShieldAlert size={28} />, title: "Not configured", sub: "Embedding is not enabled on the server." },
    network: { icon: <ShieldAlert size={28} />, title: "Can't reach the portal", sub: "Please try again." },
    error: { icon: <ShieldAlert size={28} />, title: "Something went wrong", sub: "Unable to start the embed session." },
  }[status] || { icon: <ShieldAlert size={28} />, title: "Unavailable", sub: "" };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50" data-testid="embed-grid-error">
      <div className="text-center max-w-sm px-6">
        <div className="mx-auto mb-3 w-14 h-14 rounded-2xl flex items-center justify-center bg-red-100 text-red-600">{msg.icon}</div>
        <div className="text-lg font-bold text-slate-800">{msg.title}</div>
        <div className="text-sm mt-1 text-slate-500">{msg.sub}</div>
      </div>
    </div>
  );
}
