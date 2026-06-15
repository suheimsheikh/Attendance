import React, { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { ScanLine, MapPin, Loader2, LogIn, LogOut as LogOutIcon, AlertTriangle, RotateCcw, CheckCircle2, Navigation, Coffee, ArrowLeftRight, Clock } from "lucide-react";
import { api, ApiError } from "../api";
import QrScanner from "../components/QrScanner";
import { getLocation } from "../utils";

export default function CheckIn() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [office, setOffice] = useState(null);
  const [mode, setMode] = useState("qr"); // "qr" or "gps"
  const [working, setWorking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [reason, setReason] = useState("");
  const [pendingScan, setPendingScan] = useState(null); // { qr_token } awaiting reason

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

  const handleQrScan = async (qrToken, overrideReason) => {
    setWorking(true);
    setScanning(false);
    try {
      const loc = await getLocation();
      const body = { qr_token: qrToken, latitude: loc.latitude, longitude: loc.longitude, reason: overrideReason || undefined };
      const res = await api.post(`/attendance/${action}`, body);
      toast.success(res.action === "checkin" ? `Checked in — welcome, ${res.member}!` : `Checked out — ${res.member} (${res.hours}h)`);
      setReason("");
      setPendingScan(null);
      refresh();
    } catch (err) {
      if (err instanceof ApiError && err.message.startsWith("OUT_OF_GEOFENCE:")) {
        const dist = err.message.split(":")[1];
        setPendingScan({ qr_token: qrToken, distance: dist });
        toast.warning(`About ${dist} m off-site — add a reason to continue.`);
      } else {
        toast.error(err?.message || "Failed");
      }
    } finally {
      setWorking(false);
    }
  };

  const handleGpsToggle = async () => {
    setWorking(true);
    try {
      const loc = await getLocation();
      const res = await api.post("/attendance/geo-toggle", { latitude: loc.latitude, longitude: loc.longitude, reason: reason || undefined });
      toast.success(res.action === "checkin" ? `Checked in — welcome, ${res.member}!` : `Checked out — ${res.member} (${res.hours}h)`);
      setReason("");
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setWorking(false);
    }
  };

  const startScan = () => { setPendingScan(null); setScanning(true); };

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
              ? "You're currently checked in. Scan the Office QR or use GPS to check out — or step out temporarily."
              : "Scan the Office QR code or use GPS within the geofence to check in."}
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
            {working ? <Loader2 className="animate-spin" size={16} /> : <ArrowLeftRight size={16} />} I'm back
          </button>
        </div>
      )}

      {/* Temp-exit button (only when checked in & not already out) */}
      {status?.checked_in && !onTempOut && (
        <TempExitCard onCreated={refresh} />
      )}

      {/* Mode tabs (hide while temp-out — only the "I'm back" card matters then) */}
      {!onTempOut && (
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            data-testid="mode-qr"
            onClick={() => setMode("qr")}
            className={`iu-btn ${mode === "qr" ? "iu-btn-primary" : "iu-btn-secondary"}`}
          >
            <ScanLine size={16} /> QR scan
          </button>
          <button
            data-testid="mode-gps"
            onClick={() => setMode("gps")}
            className={`iu-btn ${mode === "gps" ? "iu-btn-primary" : "iu-btn-secondary"}`}
          >
            <Navigation size={16} /> GPS only
          </button>
        </div>
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
              onClick={() => handleQrScan(pendingScan.qr_token, reason)}
              className="iu-btn-primary flex-1"
            >
              {working ? <Loader2 className="animate-spin" size={16} /> : `Confirm ${actionLabel}`}
            </button>
            <button onClick={() => { setPendingScan(null); setReason(""); }} className="iu-btn-secondary">Cancel</button>
          </div>
        </div>
      )}

      {/* Mode body — hidden while temp-out */}
      {!onTempOut && mode === "qr" && (
        <div className="iu-card p-4">
          {scanning ? (
            <>
              <QrScanner
                onScan={(text) => handleQrScan(text)}
                onError={() => setScanning(false)}
                height={320}
              />
              <div className="mt-3 flex justify-between items-center">
                <p className="text-xs text-slate-500">Point the camera at the Office QR.</p>
                <button onClick={() => setScanning(false)} className="iu-btn-ghost !h-9">Cancel</button>
              </div>
            </>
          ) : (
            <div className="py-10 text-center">
              <div className="w-16 h-16 mx-auto rounded-full bg-slate-900 text-white flex items-center justify-center mb-4">
                <ScanLine size={26} />
              </div>
              <h3 className="font-extrabold text-lg">Scan Office QR</h3>
              <p className="text-sm text-slate-500 mt-1">We'll verify your location automatically.</p>
              <button
                data-testid="start-scan-button"
                onClick={startScan}
                disabled={working}
                className="iu-btn-primary mt-5 mx-auto"
              >
                {action === "checkin" ? <LogIn size={16} /> : <LogOutIcon size={16} />} {actionLabel}
              </button>
            </div>
          )}
        </div>
      )}

      {!onTempOut && mode === "gps" && (
        <div className="iu-card p-6 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-slate-900 text-white flex items-center justify-center mb-4">
            <MapPin size={26} />
          </div>
          <h3 className="font-extrabold text-lg">GPS {actionLabel}</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-xs mx-auto">
            {action === "checkin"
              ? `Stand within ${office?.radius_m ?? 100} m of the office geofence.`
              : "Check out from anywhere — we'll flag if you're off-site."}
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
        </div>
      )}

      {office && (
        <p className="text-xs text-slate-400 mt-6 text-center">
          Office geofence: {office.radius_m} m around {office.name} • {office.timezone || "Asia/Kolkata"}
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
