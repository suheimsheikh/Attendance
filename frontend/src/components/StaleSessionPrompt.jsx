import React, { useEffect, useState } from "react";
import { Loader2, AlertCircle, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useEscape } from "../hooks/useEscape";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/**
 * StaleSessionPrompt — modal shown when the user has an open attendance session
 * from a previous day (i.e. they forgot to check out). Lets them retroactively
 * close it at their work_end, a custom time, or skip (HR will fix).
 */
export default function StaleSessionPrompt() {
  const [stale, setStale] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("default"); // default | custom
  const [customTime, setCustomTime] = useState("");

  const close = () => setStale(null);
  useEscape(stale ? close : null);

  useEffect(() => {
    let alive = true;
    api.get("/attendance/stale-session").then((r) => {
      if (alive && r?.stale) {
        setStale(r.stale);
        setCustomTime(r.stale.work_end || "18:00");
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!stale) return null;

  const send = async (action) => {
    setBusy(true);
    try {
      const r = await api.post("/attendance/resolve-stale", { session_id: stale.session_id, action });
      if (r.action === "closed") {
        toast.success(`Closed yesterday's session (${r.hours}h)`);
      } else {
        toast.success("OK — HR will sort it out");
      }
      setStale(null);
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-end md:items-center justify-center p-4" data-testid="stale-session-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex items-start gap-3 bg-amber-50">
          <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            <AlertCircle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-extrabold text-lg text-slate-900">Did you forget to check out?</h3>
            <p className="text-sm text-slate-600 mt-0.5">
              You&apos;re still showing checked-in from <span className="font-semibold">{fmtDate(stale.check_in_at)} · {fmtTime(stale.check_in_at)}</span>. When did you actually leave?
            </p>
          </div>
        </div>

        <div className="p-5 space-y-3">
          {mode === "default" ? (
            <>
              <button
                data-testid="stale-workend"
                disabled={busy}
                onClick={() => send("work_end")}
                className="w-full p-3 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-left transition flex items-center gap-3"
              >
                <Check size={18} className="text-emerald-600 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold text-slate-900 text-sm">Close at my work-end time</div>
                  <div className="text-xs text-slate-600">Mark check-out at {stale.work_end}</div>
                </div>
              </button>

              <button
                data-testid="stale-custom-open"
                disabled={busy}
                onClick={() => setMode("custom")}
                className="w-full p-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-left transition"
              >
                <div className="font-semibold text-slate-900 text-sm">I left at a different time</div>
                <div className="text-xs text-slate-600">Pick the exact time you left</div>
              </button>

              <button
                data-testid="stale-skip"
                disabled={busy}
                onClick={() => send("skip")}
                className="w-full p-3 rounded-xl text-slate-500 hover:bg-slate-50 text-sm transition"
              >
                Skip — HR will fix
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="iu-label">I left at</label>
                <input
                  data-testid="stale-custom-time"
                  type="time"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  className="iu-input"
                  autoFocus
                />
                <p className="text-[11px] text-slate-500 mt-1">Time on the day you checked in ({fmtDate(stale.check_in_at)}).</p>
              </div>
              <div className="flex gap-2">
                <button
                  data-testid="stale-custom-back"
                  onClick={() => setMode("default")}
                  className="iu-btn-secondary flex-1"
                >
                  Back
                </button>
                <button
                  data-testid="stale-custom-save"
                  disabled={busy || !customTime}
                  onClick={() => send(customTime)}
                  className="iu-btn-primary flex-1"
                >
                  {busy ? <Loader2 className="animate-spin" size={16} /> : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
