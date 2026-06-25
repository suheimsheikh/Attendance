import React, { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { MapPin, Loader2, LogIn, LogOut as LogOutIcon, AlertTriangle, RotateCcw, CheckCircle2, Navigation, Coffee, ArrowLeftRight, Clock } from "lucide-react";
import { api } from "../api";
import { getLocation } from "../utils";

export default function CheckIn() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [office, setOffice] = useState(null);
  const [working, setWorking] = useState(false);
  const [reason, setReason] = useState("");
  const [pendingScan, setPendingScan] = useState(null); // { distance } awaiting off-site reason
  const [lastFix, setLastFix] = useState(null); // {lat, lng, acc} for diagnostics
  const [locating, setLocating] = useState(""); // live "Improving fix… ±N m" text

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

  const action = status?.checked_in ? "checkout" : "checkin";
  const actionLabel = status?.checked_in ? "Check Out" : "Check In";

  // Single check-in path — GPS only. Provides an off-site override (with reason)
  // when the user is outside the configured geofence.
  const handleGpsCheckin = async (overrideReason) => {
    setWorking(true);
    try {
      const loc = await getLocation();
      const body = { latitude: loc.latitude, longitude: loc.longitude, reason: overrideReason || undefined };
      const res = await api.post(`/attendance/${action}`, body);
      toast.success(res.action === "checkin" ? `Checked in — welcome, ${res.member}!` : `Checked out — ${res.member} (${res.hours}h)`);
      setReason("");
      setPendingScan(null);
      refresh();
    } catch (err) {
      const msg = err?.message || "";
      if (typeof msg === "string" && msg.startsWith("OUT_OF_GEOFENCE:")) {
        const dist = msg.split(":")[1];
        setPendingScan({ distance: dist });
        toast.warning(`About ${dist} m off-site — add a reason to continue.`);
      } else {
        console.error("Check-in failed:", err);
        toast.error(msg || "Check-in failed");
      }
    } finally {
      setWorking(false);
    }
  };

  const handleGpsToggle = async () => {
    setWorking(true);
    setLocating("Locating you…");
    try {
      const targetAccuracy = Math.max(40, Math.min(80, Math.floor((office?.radius_m || 80) * 0.6)));
      const loc = await getLocation({
        targetAccuracy,
        maxWaitMs: 25000,
        onProgress: (fix) => {
          setLastFix({ lat: fix.latitude, lng: fix.longitude, acc: fix.accuracy });
          setLocating(`Improving fix… ±${Math.round(fix.accuracy || 0)} m`);
        },
      });
      setLastFix({ lat: loc.latitude, lng: loc.longitude, acc: loc.accuracy });
      // Guard: refuse to check in if the fix can't possibly resolve the geofence.
      const radius = office?.radius_m || 80;
      if ((loc.accuracy || 0) > radius * 2) {
        toast.error(`GPS is too imprecise (±${Math.round(loc.accuracy)} m). Step outdoors with a clear view of the sky, wait 30 s and retry.`);
        return;
      }
      const res = await api.post("/attendance/geo-toggle", { latitude: loc.latitude, longitude: loc.longitude, reason: reason || undefined });
      toast.success(res.action === "checkin" ? `Checked in — welcome, ${res.member}!` : `Checked out — ${res.member} (${res.hours}h)`);
      setReason("");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setWorking(false);
      setLocating("");
    }
  };

  const captureLocation = async () => {
    setLocating("Locating you…");
    try {
      const radius = office?.radius_m || 80;
      const targetAccuracy = Math.max(30, Math.min(80, Math.floor(radius * 0.6)));
      const loc = await getLocation({
        targetAccuracy,
        maxWaitMs: 25000,
        onProgress: (fix) => {
          setLastFix({ lat: fix.latitude, lng: fix.longitude, acc: fix.accuracy });
          setLocating(`Improving fix… ±${Math.round(fix.accuracy || 0)} m`);
        },
      });
      setLastFix({ lat: loc.latitude, lng: loc.longitude, acc: loc.accuracy });
      toast.success(`Got fix: ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)} (±${Math.round(loc.accuracy || 0)} m)`);
    } catch (err) {
      toast.error(err?.message || "Could not get location");
    } finally {
      setLocating("");
    }
  };

  const onTempOut = !!status?.on_temp_exit;
  const currentExcursion = status?.current_excursion;

  const handleTempReturn = async () => {
    setWorking(true);
    try {
      let coords = {};
      try { const loc = await getLocation(); coords = { latitude: loc.latitude, longitude: loc.longitude }; }
      catch (err) {
        // Geolocation is optional on temp-return — log and continue without coords.
        console.debug("temp-return geolocation skipped:", err?.message);
      }
      await api.post("/attendance/temp-return", coords);
      toast.success("Welcome back!");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-500"><Loader2 className="mx-auto animate-spin" /></div>;
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Check In / Out</h1>
        <p className="text-slate-500 text-sm mt-1">
          {onTempOut
            ? "You're currently stepped out. Tap Return when you're back on campus."
            : status?.checked_in
              ? "You're currently checked in. Tap below to check out — or step out temporarily."
              : "Make sure you're inside the campus geofence, then tap to check in."}
        </p>
      </header>

      {/* Status banner */}
      <div className="iu-card p-4 md:p-5 mb-6 flex items-center gap-3" data-testid="status-banner">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${onTempOut ? "bg-cyan-100 text-cyan-700" : status?.checked_in ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {onTempOut ? <Coffee size={18} /> : status?.checked_in ? <CheckCircle2 size={18} /> : <LogOutIcon size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-wide font-semibold text-slate-500">
            {onTempOut ? "Stepped out" : status?.checked_in ? "Currently on campus" : "Not on campus"}
          </div>
          <div className="text-sm font-semibold text-slate-900 truncate">
            {onTempOut
              ? `${currentExcursion.reason}${currentExcursion.expected_return ? ` · back by ${new Date(currentExcursion.expected_return).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
              : status?.checked_in
                ? `Since ${new Date(status.session.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Tap an option below to check in"}
          </div>
        </div>
      </div>

      {/* Temp-out: return button */}
      {onTempOut && (
        <div className="iu-card p-5 mb-4 text-center" data-testid="temp-return-card">
          <div className="w-14 h-14 mx-auto rounded-full bg-cyan-500 text-white flex items-center justify-center mb-3">
            <ArrowLeftRight size={22} />
          </div>
          <h3 className="font-extrabold text-lg">Returning to campus?</h3>
          <p className="text-sm text-slate-500 mt-1">
            Out since {new Date(currentExcursion.out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {currentExcursion.expected_return && " · expected back by " + new Date(currentExcursion.expected_return).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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

      {/* Temp-exit button (only when checked in & not already out) */}
      {status?.checked_in && !onTempOut && (
        <TempExitCard onCreated={refresh} />
      )}

      {/* Off-site reason prompt */}
      {pendingScan && (
        <div className="iu-card p-4 mb-4 border-amber-300 bg-amber-50" data-testid="offsite-prompt">
          <div className="flex items-center gap-2 text-amber-800 font-semibold">
            <AlertTriangle size={16} /> About {pendingScan.distance} m from the office
          </div>
          <p className="text-sm text-amber-700 mt-1">Provide a reason to {actionLabel.toLowerCase()} from off-site.</p>
          <textarea
            data-testid="reason-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Meeting offsite, returning late from duty…"
            rows={2}
            className="iu-input mt-3 !h-auto py-2"
          />
          <div className="flex gap-2 mt-3">
            <button
              data-testid="confirm-offsite-button"
              disabled={!reason.trim() || working}
              onClick={() => handleGpsCheckin(reason)}
              className="iu-btn-primary flex-1"
            >
              {working ? <Loader2 className="animate-spin" size={16} /> : `Confirm ${actionLabel}`}
            </button>
            <button onClick={() => { setPendingScan(null); setReason(""); }} className="iu-btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {!onTempOut && (
        <div className="iu-card p-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-slate-900 text-white flex items-center justify-center mb-4">
            <MapPin size={26} />
          </div>
          <h3 className="font-extrabold text-lg">{actionLabel}</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-xs mx-auto">
            {action === "checkin"
              ? `Stand within ${office?.radius_m ?? 100} m of the office geofence.`
              : "Check out from anywhere — we&apos;ll flag if you&apos;re off-site."}
          </p>
          {action === "checkout" && (
            <textarea
              data-testid="gps-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="(Optional) reason if checking out from off-site"
              rows={2}
              className="iu-input mt-4 !h-auto py-2 max-w-md mx-auto text-left"
            />
          )}
          <button
            data-testid="gps-toggle-button"
            disabled={working}
            onClick={handleGpsToggle}
            className="iu-btn-primary mt-5 mx-auto"
          >
            {working ? <Loader2 className="animate-spin" size={16} /> : (action === "checkin" ? <LogIn size={16} /> : <LogOutIcon size={16} />)}
            {actionLabel}
          </button>

          {locating && (
            <p className="text-xs text-slate-500 mt-3" data-testid="locating-status">{locating}</p>
          )}

          <button
            type="button"
            data-testid="capture-location-button"
            onClick={captureLocation}
            className="block mx-auto mt-3 text-xs font-semibold text-slate-500 underline hover:text-slate-900"
          >
            Just show my location (don&apos;t check in)
          </button>
        </div>
      )}

      {office && lastFix && (
        <GeoDiagnostic office={office} fix={lastFix} />
      )}

      {office && (
        <p className="text-xs text-slate-400 mt-6 text-center">
          Office geofence: {office.radius_m} m around {office.name} • {office.timezone || "Asia/Kolkata"}
          <br />
          <span className="text-slate-300">Office anchor: {office.latitude?.toFixed(5)}, {office.longitude?.toFixed(5)}</span>
        </p>
      )}
    </div>
  );
}

// Haversine distance in meters between two lat/lng pairs.
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function GeoDiagnostic({ office, fix }) {
  const dist = Math.round(haversine(fix.lat, fix.lng, office.latitude, office.longitude));
  const inFence = dist <= (office.radius_m || 0);
  const mapsUrl = `https://www.google.com/maps?q=${fix.lat},${fix.lng}`;
  return (
    <div className="iu-card mt-4 p-4 text-left text-xs" data-testid="geo-diagnostic">
      <div className="font-semibold text-slate-700 mb-2 flex items-center gap-1.5">
        <Navigation size={13}/> GPS diagnostic
      </div>
      <div className="grid grid-cols-3 gap-2 text-slate-600">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Your phone</div>
          <div className="font-mono">{fix.lat.toFixed(5)}, {fix.lng.toFixed(5)}</div>
          {fix.acc ? <div className="text-slate-400 text-[10px]">±{Math.round(fix.acc)} m accuracy</div> : null}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Office</div>
          <div className="font-mono">{office.latitude?.toFixed(5)}, {office.longitude?.toFixed(5)}</div>
          <div className="text-slate-400 text-[10px]">Radius {office.radius_m} m</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Distance</div>
          <div className={`font-bold ${inFence ? "text-emerald-600" : "text-amber-600"}`}>{dist} m</div>
          <div className="text-slate-400 text-[10px]">{inFence ? "Inside fence" : "Outside fence"}</div>
        </div>
      </div>
      <a
        href={mapsUrl}
        target="_blank"
        rel="noreferrer"
        data-testid="open-in-maps"
        className="block mt-3 text-[11px] font-semibold text-slate-700 underline"
      >
        Open my detected location in Google Maps →
      </a>
      {!inFence && (
        <p className="text-[11px] text-slate-500 mt-2 leading-snug">
          If the map pin looks correct but the distance is wrong, ask your admin to verify the office latitude/longitude in <b>Office Settings</b>.
          If the map pin is in the wrong spot, your phone&apos;s GPS is reporting badly — go outdoors, wait 30 s, retry.
        </p>
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
      catch (err) {
        // Geolocation is optional on temp-exit — log and continue without coords.
        console.debug("temp-exit geolocation skipped:", err?.message);
      }
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
    } finally {
      setBusy(false);
    }
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
