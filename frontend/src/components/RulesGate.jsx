import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "../api";

/** Redirects members who must accept the current Attendance Rules to /rules. */
export default function RulesGate({ enabled }) {
  const loc = useLocation();
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let ignore = false;
    const load = () => api.get("/rules").then((r) => !ignore && setState(r)).catch(() => !ignore && setState({ required: false }));
    load();
    window.addEventListener("rules-accepted", load);
    return () => { ignore = true; window.removeEventListener("rules-accepted", load); };
  }, [enabled]);
  if (!enabled || !state) return null;
  if (state.required && !state.accepted && loc.pathname !== "/rules") return <Navigate to="/rules" replace />;
  return null;
}
