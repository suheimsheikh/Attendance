import React, { useEffect, useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Loader2, LogOut as LogOutIcon, CheckCircle2, MapPin, Coffee, ArrowLeftRight, Clock, AlertTriangle, Camera } from "lucide-react";
import { api } from "../api";
import { useAuth } from "../auth";
import { getLocation, speakLateMessage, resolveNearestSite } from "../utils";
import { useGeoPermission } from "../hooks/useGeoPermission";
import SelfieCapture from "../components/SelfieCapture";
import DailyContent from "../components/DailyContent";
import ReasonPicker from "../components/ReasonPicker";
import GeoPermissionBanner from "../components/GeoPermissionBanner";
import OutOfGeofenceModal from "../components/OutOfGeofenceModal";

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
  const [photoStatus, setPhotoStatus] = useState(null);
  const [sites, setSites] = useState([]);
  // Pending off-geofence check-in awaiting a reason from the user.
  // { lat, lng, distance_m, nearest_name, nearest_distance_m }.
  const [offGeoPending, setOffGeoPending] = useState(null);
  const geoPerm = useGeoPermission();

  const photoNeeded = photoStatus ? photoStatus.needs_photo : !user?.photo;

  const refresh = useCallback(async () => {
    try {
      const [s, o, ps, si] = await Promise.all([
        api.get("/attendance/status"),
        api.get("/office"),
        api.get("/me/photo-status").catch(() => null),
        api.get("/sites").catch(() => []),
      ]);
      setStatus(s);
      setOffice(o);
      if (ps) setPhotoStatus(ps);
      setSites(Array.isArray(si) ? si : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onTempOut = !!status?.on_temp_exit;
  const currentExcursion = status?.current_excursion;
  const actionLabel = status?.checked_in ? "Leaving Campus" : "I showed up 😊";

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

  // Core check-in/out logic — extracted so it can be invoked directly after
  // the first-time selfie is captured (without re-tripping the photo guard).
  // Also invoked with an explicit `geoReason` after the off-geofence modal
  // is confirmed, so the reason lands on the attendance row.
  const performToggle = async (geoReason = null) => {
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

      // Pre-flight geofence check on the client — only for CHECK-INS.
      // Checkouts are trusted (person is leaving; asking a reason
      // would just create friction). If we have NO GPS fix at all
      // (permission denied / hardware off), we let the check-in
      // through — the backend stamps `geo_unavailable=true` and admins
      // can follow up from Data Quality. Enforcing a reason here would
      // block members on locked-down browsers from checking in at all.
      if (lat != null && lng != null && !status?.checked_in && !geoReason) {
        const resolved = resolveNearestSite(lat, lng, office, sites);
        if (resolved?.out_of_geofence) {
          setOffGeoPending({
            lat, lng,
            distance_m: resolved.nearest_distance_m,
            nearest_name: resolved.nearest_name,
          });
          setWorking(false);
          return;   // await user's reason
        }
      }

      const body = lat != null && lng != null
        ? { latitude: lat, longitude: lng }
        : { latitude: 0, longitude: 0 };
      if (otInfo && overtimeReason.trim()) body.overtime_reason = overtimeReason.trim();
      if (geoReason) body.reason = geoReason;
      const res = await api.post("/attendance/geo-toggle", body);
      const dist = res.distance_m;
      setLastDistance({ dist, acc, off: res.out_of_geofence });
      // Location-aware toast — tell the member which geofence they landed
      // in so they can spot a mis-tagged check-in immediately.
      const locBit = res.site_name ? ` at ${res.site_name}` : "";
      toast.success(
        res.action === "checkin"
          ? `Checked in${locBit} — welcome, ${res.member}!`
          : `Checked out${locBit} — ${res.member} (${res.hours}h)`
      );
      // Play a friendly Indian-female voice nudge when a check-in is marked
      // late — handy reminder for the member at the device.
      if (res.action === "checkin" && res.late) {
        speakLateMessage(res.late_minutes, res.member);
      }
      setOvertimeReason("");
      setOffGeoPending(null);
      refresh();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setWorking(false);
      setLocating("");
    }
  };

  const handleToggle = async () => {
    // Force a selfie when the member has no photo on file OR their photo is
    // older than the refresh threshold (365 days). The captured selfie becomes
    // their new profile photo and check-in continues automatically.
    if (photoNeeded && !status?.checked_in) {
      setShowSelfie(true);
      return;
    }
    performToggle();
  };

  const saveSelfie = async (dataUrl) => {
    if (!user?.id) return;
    setShowSelfie(false);
    try {
      await api.post("/members/me/photo", { photo: dataUrl });
      await refreshMe();
      // Pull fresh photo-status so the yearly refresh logic recomputes correctly.
      api.get("/me/photo-status").then(setPhotoStatus).catch(() => {});
      toast.success("Photo saved — checking you in…");
    } catch (err) {
      toast.error(err?.message || "Couldn't save photo");
      return;
    }
    // Auto-proceed with the actual check-in so the member doesn't have to tap again.
    performToggle();
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
      <header className="mb-6 text-center md:text-left">
        <h2 className="text-lg md:text-xl font-bold tracking-tight md:hidden">Check In / Out</h2>
        <h2 className="hidden md:block text-2xl md:text-3xl font-extrabold tracking-tight">Check In / Out</h2>
        <p className="text-slate-500 text-sm mt-1">
          {onTempOut
            ? "You're currently stepped out. Tap Return when you're back."
            : status?.checked_in
              ? "You're on campus. Tap below when you're leaving."
              : "Tap once to log your arrival. Your distance from the office is recorded for the log."}
        </p>
      </header>

      <DailyContent />

      <GeoPermissionBanner state={geoPerm} />

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
              ? `${currentExcursion?.reason || ""}${currentExcursion?.expected_return ? ` · back by ${currentExcursion.expected_return}` : ""}`
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
          <Greeting user={user} checkedIn={!!status?.checked_in} />
          {otInfo && (
            <div className="mb-5 text-left rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="ot-reason-block">
              <div className="flex items-start gap-2 mb-2">
                <AlertTriangle size={14} className="text-amber-700 mt-0.5 shrink-0" />
                <div className="text-xs text-amber-800 font-semibold">{otInfo.label}</div>
              </div>
              <label className="iu-label text-amber-900">Reason for overtime (optional)</label>
              <ReasonPicker
                value={overtimeReason}
                onChange={setOvertimeReason}
                placeholder={otInfo.kind === "early" ? "e.g. Pre-event setup, training session…" : "e.g. End-of-day reconciliation, regatta cleanup…"}
                variant="amber"
                testId="ot-reason"
              />
              <p className="text-[11px] text-amber-700 mt-1.5">Admin will review and approve overtime tomorrow morning. Only staff accrue overtime.</p>
            </div>
          )}
          <button
            data-testid="self-checkin-button"
            disabled={working}
            onClick={handleToggle}
            className={`mx-auto inline-flex flex-col items-center justify-center gap-2 rounded-3xl shadow-xl transition active:scale-[0.97] disabled:opacity-60 w-44 h-44 ${
              status?.checked_in
                ? "bg-gradient-to-br from-rose-500 to-rose-700 text-white"
                : "bg-white text-slate-900 ring-2 ring-sky-100 hover:ring-sky-200"
            }`}
          >
            {working ? (
              <Loader2 className="animate-spin" size={42} />
            ) : status?.checked_in ? (
              <LogOutIcon size={42} />
            ) : (
              // YCH club logo replaces the generic LogIn icon on the
              // check-in state (7 Jul 2026 user-requested — the club
              // brand is what members recognise, not an abstract door
              // arrow). Rose LogOut state stays generic since it's a
              // "leaving" action, not a brand moment.
              <img
                src="/icon-192.png"
                alt="Yacht Club of Hyderabad"
                className="w-20 h-20 object-contain"
                draggable={false}
              />
            )}
            <span className="text-base font-extrabold tracking-tight">{actionLabel}</span>
          </button>

          {photoNeeded && !status?.checked_in && (
            <p className="text-[11px] text-slate-500 mt-3 flex items-center justify-center gap-1.5" data-testid="selfie-hint">
              <Camera size={12} />
              {photoStatus?.reason === "expired"
                ? "Your photo is over a year old — we'll grab a fresh selfie first."
                : "We'll grab a quick selfie first — one tap and you're done."}
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
          title={photoStatus?.reason === "expired" ? "Time for a fresh photo" : "One quick selfie"}
          subtitle={photoStatus?.reason === "expired"
            ? "Your photo's over a year old — let's update it so your coach can still recognise you on the muster."
            : "So your coach can recognise you on the muster list. You only do this once."}
          onCapture={saveSelfie}
          onClose={() => setShowSelfie(false)}
        />
      )}

      <OutOfGeofenceModal
        open={!!offGeoPending}
        onClose={() => setOffGeoPending(null)}
        onConfirm={(reason) => performToggle(reason)}
        distanceM={offGeoPending?.distance_m}
        nearestName={offGeoPending?.nearest_name}
        submitting={working}
      />
    </div>
  );
}


// Quick-pick durations for the one-tap Step-out card. The "return-by"
// time is auto-computed as now + the selected minutes — saves the user
// fiddling with a time picker just to log a lunch break.
const STEP_OUT_DURATIONS = [
  { min: 30,  label: "30 min" },
  { min: 60,  label: "1 hour" },   // default
  { min: 120, label: "2 hours" },
];

function fmtHmLocal(d) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** Personalised greeting shown above the check-in button —
 * "Good morning, ARUNA 👋". Time-of-day slot follows local hour:
 * 05-11 morning · 12-16 afternoon · 17-21 evening · else night.
 * When the member is already checked in we shift to a "welcome back
 * on campus" register so the copy doesn't feel repetitive.
 *
 * 7 Jul 2026 — birthday flourish: when today's MM-DD matches the
 * member's `date_of_birth`, the wave 👋 becomes a cake 🎂 and the
 * greeting reads "Happy birthday, ARUNA 🎂".
 */
function Greeting({ user, checkedIn }) {
  const firstName = (user?.full_name || "").trim().split(/\s+/)[0] || "there";

  // Birthday check — compare MM-DD only so the year is irrelevant.
  const dob = user?.date_of_birth || "";
  const now = new Date();
  const todayMD = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const isBirthday = /^\d{4}-\d{2}-\d{2}$/.test(dob) && dob.slice(5) === todayMD;

  if (isBirthday) {
    return (
      <div
        className="mb-4 text-amber-800 font-extrabold text-lg md:text-xl bg-amber-50 rounded-xl px-3 py-2 ring-1 ring-amber-200"
        data-testid="checkin-greeting"
      >
        Happy birthday, {firstName} 🎂
      </div>
    );
  }

  const hour = now.getHours();
  let slot = "night";
  if (hour >= 5 && hour < 12) slot = "morning";
  else if (hour < 17) slot = "afternoon";
  else if (hour < 22) slot = "evening";
  const label = checkedIn
    ? `Ready to head out, ${firstName}?`
    : `Good ${slot}, ${firstName} 👋`;
  return (
    <div
      className="mb-4 text-slate-700 font-semibold text-base md:text-lg"
      data-testid="checkin-greeting"
    >
      {label}
    </div>
  );
}

function TempExitCard({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [durationMin, setDurationMin] = useState(60); // default 1 hour
  const [customTime, setCustomTime] = useState("");   // active when durationMin === null
  const [busy, setBusy] = useState(false);

  // Computed return time → shown inline so the user can sanity-check
  // before tapping Step out. Recomputed every render — cheap.
  const computedReturn = (() => {
    if (durationMin == null) return customTime || "";
    const now = new Date();
    now.setMinutes(now.getMinutes() + durationMin);
    return fmtHmLocal(now);
  })();

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!reason.trim()) { toast.error("Tell us where you're headed"); return; }
    setBusy(true);
    try {
      let coords = {};
      try { const loc = await getLocation(); coords = { latitude: loc.latitude, longitude: loc.longitude }; }
      catch (err) { console.debug("temp-exit geolocation skipped:", err?.message); }
      await api.post("/attendance/temp-exit", {
        reason: reason.trim(),
        expected_return: computedReturn || null,
        ...coords,
      });
      toast.success(`Stepped out — see you by ${computedReturn || "later"} 👋`);
      setOpen(false);
      setReason("");
      setDurationMin(60);
      setCustomTime("");
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
          <div className="text-xs text-slate-600">Quick lunch, errand, meeting — one tap and you&apos;re out.</div>
        </div>
        <button data-testid="temp-exit-open" onClick={() => setOpen(true)} className="iu-btn-secondary !h-9 !px-3 shrink-0">
          <ArrowLeftRight size={14} /> Step out
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="iu-card p-4 mb-4 space-y-3" data-testid="temp-exit-form">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-lg bg-cyan-500/15 text-cyan-700 flex items-center justify-center"><Coffee size={16}/></div>
        <h3 className="font-extrabold">Step out</h3>
      </div>

      <div>
        <label className="iu-label">Where are you headed?</label>
        <input
          data-testid="temp-exit-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Lunch · clinic · errand…"
          className="iu-input"
          autoFocus
        />
      </div>

      {/* Quick-pick duration chips + Custom return time fallback */}
      <div>
        <label className="iu-label">How long?</label>
        <div className="grid grid-cols-4 gap-2" data-testid="temp-exit-durations">
          {STEP_OUT_DURATIONS.map((d) => (
            <button
              key={d.min}
              type="button"
              onClick={() => setDurationMin(d.min)}
              data-testid={`temp-exit-dur-${d.min}`}
              className={`iu-btn ${durationMin === d.min ? "iu-btn-primary" : "iu-btn-secondary"} !h-10`}
            >
              {d.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDurationMin(null)}
            data-testid="temp-exit-dur-custom"
            className={`iu-btn ${durationMin === null ? "iu-btn-primary" : "iu-btn-secondary"} !h-10`}
            title="Pick a specific return time"
          >
            Custom
          </button>
        </div>
        {durationMin === null && (
          <div className="relative mt-2">
            <Clock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              data-testid="temp-exit-custom-time"
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              className="iu-input pl-10"
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Inline ETA preview — single source of truth, mirrors the value
          that will be sent to the backend. Mounts only when we have a
          valid time to display. */}
      {computedReturn && (
        <div className="rounded-lg bg-cyan-50/70 border border-cyan-200 px-3 py-2 flex items-center gap-2 text-xs text-cyan-900" data-testid="temp-exit-eta">
          <Clock size={13} className="text-cyan-600 shrink-0" />
          You&apos;ll be back by <strong className="font-extrabold">{computedReturn}</strong>
          {durationMin != null && <span className="opacity-60">· {STEP_OUT_DURATIONS.find((x) => x.min === durationMin)?.label}</span>}
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={() => { setOpen(false); setReason(""); setDurationMin(60); setCustomTime(""); }} className="iu-btn-secondary flex-1">Cancel</button>
        <button data-testid="temp-exit-submit" type="submit" disabled={busy || !reason.trim() || (durationMin == null && !customTime)} className="iu-btn-primary flex-1">
          {busy ? <Loader2 className="animate-spin" size={16} /> : <><ArrowLeftRight size={14}/> Step out</>}
        </button>
      </div>
    </form>
  );
}
