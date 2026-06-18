import React, { useEffect, useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Loader2, LogIn, LogOut as LogOutIcon, CheckCircle2, MapPin, Coffee, ArrowLeftRight, Clock, AlertTriangle, Camera } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { getLocation } from "../utils";
import SelfieCapture from "../components/SelfieCapture";

function hmNow() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}
function hmParse(s) {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}
const OT_THRESHOLD = 30;

export default function SelfCheckIn() {
  const { user, refreshMe } = useAuth();
  const [status, setStatus] = useState(null);
  const [office, setOffice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [locating, setLocating] = useState("");
  const [lastDistance, setLastDistance] = useState(null);
  const [overtimeReason, setOvertimeReason] = useState("");
  const [showSelfie, setShowSelfie] = useState(false);

  const hasPhoto = !!user?.photo;

  const refresh = useCallback(async () => {
    try {
      const [s, o] = await Promise.all([api.get("/attendance/status"), api.get("/office")]);
      setStatus(s);
      setOffice(o);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onTempOut = !!status?.on_temp_exit;
  const currentExcursion = status?.current_excursion;
  const actionLabel = status?.checked_in ? "I'm Leaving" : "I'm Here";

  // Overtime detection (staff only).
  const otInfo = useMemo(() => {
    if (user?.category !== "staff") return null;
    const wsMin = hmParse(user?.work_start);
    const weMin = hmParse(user?.work_end);
    const now = hmNow();
    if (!status?.checked_in) {
      if (wsMin == null) return null;
      const diff = wsMin - now;
      if (diff >= OT_THRESHOLD) {
        return { kind: "early", minutes: diff, label: `You're checking in ${diff} min before your start time (${user.work_start})` };
      }
    } else {
      if (weMin == null) return null;
      const diff = now - weMin;
      if (diff >= OT_THRESHOLD) {
        return { kind: "late", minutes: diff, label: `You're checking out ${diff} min after your end time (${user.work_end})` };
      }
    }
    return null;
  }, [user, status]);

  const saveSelfie = async (dataUrl) => {
    if (!user?.id) return;
    await api.post("/members/me/photo", { photo: dataUrl });
    await refreshMe();
    setShowSelfie(false);
    toast.success("Photo saved");
  };

  const handleToggle = async () => {
    // First time someone without a photo checks in → prompt for selfie.
    if (!hasPhoto && !status?.checked_in) {
      setShowSelfie(true);
      return;
    }
    setWorking(true);
    setLocating("Getting your location…");
    let lat = null, lng = null, acc = null;
    try {
      try {
        const loc = await getLocation({ targetAccuracy: 100, maxWaitMs: 8000 });
        lat = loc.latitude; lng = loc.longitude; acc = loc.accuracy;
      } catch (err) {
        console.debug("location unavailable, proceeding without:", err?.message);
      }
      setLocating("");
      const body = lat != null && lng != null
        ? { latitude: lat, longitude: lng }
        : { latitude: 0, longitude: 0 };
      if (otInfo && overtimeReason.trim()) body.overtime_reason = overtimeReason.trim();
      const res = await api.post("/attendance/geo-toggle", body);
      const dist = res.distance_m;
      setLastDistance({ dist, acc, off: res.out_of_geofence });
      toast.success(
        res.action === "checkin"
          ? `Checked in — welcome, ${res.member}!`
          : `Checked out — ${res.member} (${res.hours}h)`
      );
      setOvertimeReason("");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setWorking(false);
      setLocating("");
    }
  };

  const handleTempReturn = async () => {
    setWorking(true);
    try {
      let coords = {};
      try { const loc = await getLocation(); coords = { latitude: loc.latitude, longitude: loc.longitude }; }
      catch (err) { console.debug("temp-return geolocation skipped:", err?.message); }
      await api.post("/attendance/temp-return", coords);
      toast.success("Welcome back!");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally { setWorking(false); }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-500"><Loader2 className="mx-auto animate-spin" /></div>;
  }

  return (
    <div className="p-4 md:p-8 max-w-xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Check In / Out</h1>
        <p className="text-slate-500 text-sm mt-1">
          {onTempOut
            ? "You're currently stepped out. Tap Return when you're back."
            : status?.checked_in
              ? "You're on campus. Tap below when you're leaving."
              : "Tap once to log your arrival. Your distance from the office is recorded for the log."}
        </p>
      </header>

      {/* Status banner */}
      <div className="iu-card p-4 mb-6 flex items-center gap-3" data-testid="status-banner">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${onTempOut ? "bg-cyan-100 text-cyan-700" : status?.checked_in ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {onTempOut ? <Coffee size={18} /> : status?.checked_in ? <CheckCircle2 size={18} /> : <LogOutIcon size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-500">
            {onTempOut ? "Stepped out" : status?.checked_in ? "Currently on campus" : "Not on campus"}
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate">
            {onTempOut
              ? `${currentExcursion?.reason || ""}${currentExcursion?.expected_return ? ` · back by ${new Date(currentExcursion.expected_return).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
              : status?.checked_in
                ? `Since ${new Date(status.session.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Tap the button below to check in"}
          </div>
        </div>
      </div>

      {/* Temp-out: return */}
      {onTempOut && (
        <div className="iu-card p-5 mb-4 text-center" data-testid="temp-return-card">
          <div className="w-14 h-14 mx-auto rounded-full bg-cyan-500 text-white flex items-center justify-center mb-3">
            <ArrowLeftRight size={22} />
          </div>
          <h3 className="font-extrabold text-lg">Returning to campus?</h3>
          <p className="text-sm text-slate-500 mt-1">
            Out since {new Date(currentExcursion.out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </p>
          <button
            data-testid="temp-return-button"
            onClick={handleTempReturn}
            disabled={working}
            className="iu-btn-primary mt-4 mx-auto"
          >
            {working ? <Loader2 className="animate-spin" size={16} /> : <ArrowLeftRight size={16} />} I&apos;m back
          </button>
        </div>
      )}

      {/* Temp-exit card (only when checked in & not already out) */}
      {status?.checked_in && !onTempOut && (
        <TempExitCard onCreated={refresh} />
      )}

      {/* Big primary check-in/out button */}
      {!onTempOut && (
        <div className="iu-card p-8 text-center" data-testid="self-checkin-card">
          {otInfo && (
            <div className="mb-5 text-left rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="ot-reason-block">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle size={14} className="text-amber-700 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-800 font-semibold">{otInfo.label}</div>
              </div>
              <label className="iu-label text-amber-900">Reason for overtime (optional)</label>
              <textarea
                data-testid="ot-reason-input"
                rows={2}
                value={overtimeReason}
                onChange={(e) => setOvertimeReason(e.target.value)}
                placeholder={otInfo.kind === "early" ? "e.g. Pre-event setup, training session…" : "e.g. End-of-day reconciliation, regatta cleanup…"}
                className="iu-input !h-auto py-2"
              />
              <p className="text-[11px] text-amber-700 mt-1.5">Admin will review and approve overtime tomorrow morning.</p>
            </div>
          )}
          <button
            data-testid="self-checkin-button"
            disabled={working}
            onClick={handleToggle}
            className={`mx-auto inline-flex flex-col items-center justify-center gap-2 rounded-3xl shadow-xl transition active:scale-[0.97] disabled:opacity-60 w-44 h-44 text-white ${
              status?.checked_in
                ? "bg-gradient-to-br from-rose-500 to-rose-700"
                : "bg-gradient-to-br from-emerald-500 to-emerald-700"
            }`}
          >
            {working ? (
              <Loader2 className="animate-spin" size={42} />
            ) : status?.checked_in ? (
              <LogOutIcon size={42} />
            ) : (
              <LogIn size={42} />
            )}
            <span className="text-lg font-extrabold tracking-tight">{actionLabel}</span>
          </button>

          {!hasPhoto && !status?.checked_in && (
            <p className="text-[11px] text-slate-500 mt-3 flex items-center justify-center gap-1.5" data-testid="selfie-hint">
              <Camera size={12} /> We&apos;ll grab a quick selfie first — one tap and you&apos;re done.
            </p>
          )}

          {locating && (
            <p className="text-xs text-slate-500 mt-4" data-testid="locating-status">{locating}</p>
          )}

          {!locating && lastDistance && lastDistance.dist != null && (
            <div className="mt-5 text-xs text-slate-600 flex items-center justify-center gap-1.5" data-testid="last-distance">
              <MapPin size={13} className="text-slate-400" />
              Logged {Math.round(lastDistance.dist)} m from the office
              {lastDistance.acc ? <span className="text-slate-400">· ±{Math.round(lastDistance.acc)} m</span> : null}
              {lastDistance.off ? <span className="ml-1 text-amber-600 font-semibold">off-site</span> : <span className="ml-1 text-emerald-600 font-semibold">on-site</span>}
            </div>
          )}
        </div>
      )}

      {office && (
        <p className="text-[11px] text-slate-400 mt-6 text-center">
          Distance is recorded but not enforced · Office radius {office.radius_m} m · {office.timezone || "Asia/Kolkata"}
        </p>
      )}

      {showSelfie && (
        <SelfieCapture
          title="One quick selfie"
          subtitle="So your coach can recognise you on the muster list."
          onCapture={saveSelfie}
          onClose={() => setShowSelfie(false)}
        />
      )}
    </div>
  );
}


function TempExitCard({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expectedReturn, setExpectedReturn] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!reason.trim()) { toast.error("Tell us why"); return; }
    setBusy(true);
    try {
      let coords = {};
      try { const loc = await getLocation(); coords = { latitude: loc.latitude, longitude: loc.longitude }; }
      catch (err) { console.debug("temp-exit geolocation skipped:", err?.message); }
      await api.post("/attendance/temp-exit", {
        reason: reason.trim(),
        expected_return: expectedReturn || null,
        ...coords,
      });
      toast.success("Stepped out — enjoy!");
      setOpen(false);
      setReason("");
      setExpectedReturn("");
      onCreated?.();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally { setBusy(false); }
  };

  if (!open) {
    return (
      <div className="iu-card p-4 mb-4 flex items-center gap-3 border-cyan-200/70 bg-cyan-50/40" data-testid="temp-exit-prompt">
        <div className="w-10 h-10 rounded-lg bg-cyan-500/15 text-cyan-700 flex items-center justify-center shrink-0">
          <Coffee size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-slate-900 text-sm">Stepping out for a bit?</div>
          <div className="text-xs text-slate-600">Log a temporary exit (lunch, errand, etc.). You remain on office hours.</div>
        </div>
        <button data-testid="temp-exit-open" onClick={() => setOpen(true)} className="iu-btn-secondary !h-9 !px-3 shrink-0">
          <ArrowLeftRight size={14} /> Temp exit
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="iu-card p-4 mb-4 space-y-3" data-testid="temp-exit-form">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-lg bg-cyan-500/15 text-cyan-700 flex items-center justify-center"><Coffee size={16}/></div>
        <h3 className="font-extrabold">Step out temporarily</h3>
      </div>
      <div>
        <label className="iu-label">Reason</label>
        <input
          data-testid="temp-exit-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Lunch · medical · personal errand…"
          className="iu-input"
          autoFocus
        />
      </div>
      <div>
        <label className="iu-label">Expected return <span className="text-slate-400 normal-case font-normal">(optional)</span></label>
        <div className="relative">
          <Clock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="temp-exit-expected"
            type="time"
            value={expectedReturn}
            onChange={(e) => setExpectedReturn(e.target.value)}
            className="iu-input pl-10"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => { setOpen(false); setReason(""); setExpectedReturn(""); }} className="iu-btn-secondary flex-1">Cancel</button>
        <button data-testid="temp-exit-submit" type="submit" disabled={busy || !reason.trim()} className="iu-btn-primary flex-1">
          {busy ? <Loader2 className="animate-spin" size={16} /> : <><ArrowLeftRight size={14}/> Step out</>}
        </button>
      </div>
    </form>
  );
}
