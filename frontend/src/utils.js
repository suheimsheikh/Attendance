// Browser device id + helpers.
const DEVICE_KEY = "ishowedup_device_id";

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = "web-" + (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getDeviceInfo() {
  const ua = navigator.userAgent || "";
  let device_name = "Web Browser";
  let model = navigator.platform || "Web";
  // Light parsing for friendly labels
  if (/Edg\//.test(ua)) device_name = "Edge";
  else if (/Chrome\//.test(ua)) device_name = "Chrome";
  else if (/Firefox\//.test(ua)) device_name = "Firefox";
  else if (/Safari\//.test(ua)) device_name = "Safari";
  return { device_name, model, platform: "web" };
}

// Force IST across every time/date render so the UI stays consistent
// regardless of the browser's local timezone (matches the backend which
// uses office_tz = Asia/Kolkata). 20 Feb 2026 timezone audit.
const OFFICE_TZ = "Asia/Kolkata";

export function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", timeZone: OFFICE_TZ,
    });
  } catch { return ""; }
}

/**
 * Format a date as `dd/mm/yy` (Indian standard, 2-digit year). Used in
 * headers, tables, list rows, and anywhere a numeric date is shown to
 * a human. Accepts both `YYYY-MM-DD` strings and full ISO timestamps.
 *
 * 9 Feb 2026: standardised on 2-digit year across the whole app per
 * user request ("change the date formats across the board to ddmmyy").
 * 20 Feb 2026: full ISO timestamps (with a time component) now render
 * in IST so a check-in at 23:45 IST doesn't slip to "the next day" on
 * a UTC-tz browser.
 */
export function formatDate(d) {
  if (!d) return "";
  try {
    // Pure date strings (`YYYY-MM-DD`) are timezone-agnostic — parse
    // as local midnight to avoid the UTC → previous-day flip.
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const [y, m, day] = d.split("-").map(Number);
      return `${String(day).padStart(2, "0")}/${String(m).padStart(2, "0")}/${String(y).slice(-2)}`;
    }
    // Full ISO timestamps: render in IST via `en-GB` (dd/mm/yy).
    const parts = new Date(d).toLocaleDateString("en-GB", {
      day: "2-digit", month: "2-digit", year: "2-digit", timeZone: OFFICE_TZ,
    });
    return parts;  // en-GB with 2-digit year already outputs dd/mm/yy
  } catch { return d; }
}

/**
 * Short weekday name ("Mon", "Sat"…) for a date. Same parsing rules as
 * `formatDate`: pure `YYYY-MM-DD` strings parse as local midnight, full
 * ISO timestamps render in IST.
 */
export function dayOfWeek(d) {
  if (!d) return "";
  try {
    if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return new Date(d + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" });
    }
    return new Date(d).toLocaleDateString("en-GB", { weekday: "short", timeZone: OFFICE_TZ });
  } catch { return ""; }
}

/**
 * Compact `dd/mm/yy` — same as `formatDate` since we standardised on
 * 2-digit year (9 Feb 2026). Kept as a distinct export so any code
 * expecting the "shortest possible" flavour stays wired up.
 */
export function shortDate(d) {
  return formatDate(d);
}

export function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
}

/**
 * Progressive GPS lookup. Uses watchPosition so we get an early (rough) reading
 * fast, then keep improving as the GPS satellites lock in. Resolves as soon as
 * a fix beats `targetAccuracy` m OR `maxWaitMs` elapses (whichever first).
 *
 * `onProgress(fix)` (optional) — called whenever a new (better) fix arrives so
 * the UI can show live "± Nm accuracy" feedback.
 */
export async function getLocation({ targetAccuracy = 50, maxWaitMs = 25000, onProgress } = {}) {
  if (!navigator.geolocation) {
    throw new Error("Geolocation not supported in this browser");
  }
  return new Promise((resolve, reject) => {
    let best = null;
    let watcher = null;
    let resolved = false;

    const finish = (result, err) => {
      if (resolved) return;
      resolved = true;
      if (watcher !== null) {
        try { navigator.geolocation.clearWatch(watcher); }
        catch (err) { console.debug("clearWatch failed (already cleared?):", err?.message); }
      }
      clearTimeout(timer);
      if (result) resolve(result);
      else reject(err);
    };

    const timer = setTimeout(() => {
      if (best) finish(best);
      else finish(null, new Error("Couldn't get a GPS fix in 25 s. Step outdoors with a clear view of the sky and try again."));
    }, maxWaitMs);

    try {
      watcher = navigator.geolocation.watchPosition(
        (pos) => {
          const fix = {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          };
          if (!best || (fix.accuracy ?? Infinity) < (best.accuracy ?? Infinity)) {
            best = fix;
            try { onProgress?.(fix); }
            catch (err) { console.debug("onProgress callback threw:", err?.message); }
          }
          if ((fix.accuracy ?? Infinity) <= targetAccuracy) finish(fix);
        },
        (err) => {
          // Permission denial or hard unavailability — bail immediately.
          if (err.code === 1 || err.code === 2) {
            const msg = err.code === 1
              ? "Location permission denied — enable it in your browser settings."
              : "Position unavailable — try moving outdoors or near a window.";
            finish(null, new Error(msg));
          }
          // For code=3 (timeout per-event), keep waiting — watcher will retry.
        },
        { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 0 }
      );
    } catch (e) {
      finish(null, new Error(e?.message || "Could not start GPS watcher"));
    }
  });
}

/**
 * Haversine distance in metres between two lat/lng points. Mirrors the
 * backend's `_resolve_site_for` so the front-end can pre-flight geofence
 * resolution without a round-trip.
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => typeof v !== "number" || Number.isNaN(v))) return null;
  const R = 6371000;   // Earth radius in metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Given a GPS fix + the loaded `office` config + list of training-location
 * `sites`, return the nearest configured location and whether the fix
 * falls inside any geofence. Mirrors backend `_resolve_site_for` so the
 * check-in UI can show the resolved site BEFORE hitting the server, and
 * prompt for a reason when the member is outside every geofence.
 *
 * Returns `{ site_id, site_name, distance_m, out_of_geofence,
 *            nearest_name, nearest_distance_m }`.
 *   • `site_id`/`site_name` = the geofence the fix fell inside (null
 *     when out_of_geofence).
 *   • `nearest_name`/`nearest_distance_m` = always populated (even when
 *     out) so the UI can say "850m from Main Club" in the reason prompt.
 */
export function resolveNearestSite(lat, lng, office, sites) {
  if (lat == null || lng == null) return null;
  const candidates = [];
  if (office && typeof office.latitude === "number" && typeof office.longitude === "number") {
    candidates.push({
      id: null,
      name: office.name || "Main Club",
      lat: office.latitude,
      lng: office.longitude,
      radius: Number(office.radius_m) || 100,
    });
  }
  for (const s of sites || []) {
    if (s.active === false) continue;
    if (typeof s.latitude !== "number" || typeof s.longitude !== "number") continue;
    candidates.push({
      id: s.id,
      name: s.name,
      lat: s.latitude,
      lng: s.longitude,
      radius: Number(s.radius_m) || 100,
    });
  }
  if (candidates.length === 0) {
    return { site_id: null, site_name: null, distance_m: null,
             out_of_geofence: false, nearest_name: null, nearest_distance_m: null };
  }
  let nearest = null;
  let insideMatch = null;
  for (const c of candidates) {
    const d = haversineMeters(lat, lng, c.lat, c.lng);
    if (d == null) continue;
    if (!nearest || d < nearest.d) nearest = { ...c, d };
    if (d <= c.radius && (!insideMatch || d < insideMatch.d)) insideMatch = { ...c, d };
  }
  if (insideMatch) {
    return {
      site_id: insideMatch.id,
      site_name: insideMatch.name,
      distance_m: insideMatch.d,
      out_of_geofence: false,
      nearest_name: insideMatch.name,
      nearest_distance_m: insideMatch.d,
    };
  }
  return {
    site_id: null,
    site_name: null,
    distance_m: nearest?.d ?? null,
    out_of_geofence: true,
    nearest_name: nearest?.name ?? null,
    nearest_distance_m: nearest?.d ?? null,
  };
}


export function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** ISO date string (YYYY-MM-DD) for tomorrow in the browser's local
 * timezone. Used by the Late-Coming apply form (added 7 Jul 2026 —
 * user-requested since most late-comings are filed the previous night). */
export function tomorrowIso() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function categoryLabel(cat) {
  return { athlete: "Athlete", staff: "Staff", coach: "Coach", executive: "Executive" }[cat] || cat;
}

/**
 * Read an image file, shrink it to `maxPx` on the longest side, and return
 * a JPEG data: URL. Shared by Member Form and the inline avatar-uploader on
 * the Members table.
 */
export function fileToResizedDataUrl(file, maxPx = 320) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = r.result;
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export const statusConfig = {
  on_campus: { label: "On Campus", color: "#10B981", bg: "rgba(16,185,129,0.12)", icon: "checkmark" },
  temp_out:  { label: "Stepped Out", color: "#06B6D4", bg: "rgba(6,182,212,0.14)", icon: "out" },
  on_tour:   { label: "On Tour",   color: "#F97316", bg: "rgba(249,115,22,0.12)", icon: "plane" },
  on_leave:  { label: "On Leave",  color: "#F59E0B", bg: "rgba(245,158,11,0.12)", icon: "bed" },
  absent:    { label: "Absent",    color: "#DC2626", bg: "rgba(220,38,38,0.12)",   icon: "exit" },
  exited:    { label: "Left",      color: "#6B7280", bg: "rgba(107,114,128,0.12)", icon: "exit" },
  not_due:   { label: "Not yet due", color: "#94A3B8", bg: "rgba(148,163,184,0.12)", icon: "exit" },
};

/**
 * Pick the best available Indian-female voice from the SpeechSynthesis
 * voice list. Falls back gracefully through (in order):
 *   1. Known Indian-female voice names (Veena, Heera, Lekha, Isha…)
 *   2. Any en-IN voice flagged as female (Chrome on Android)
 *   3. Any en-IN voice
 *   4. Any English voice flagged as female
 *   5. The platform default
 * Browsers populate voices async — call after `voiceschanged` fires.
 */
function pickIndianFemaleVoice() {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  if (voices.length === 0) return null;
  const knownIndianFemaleNames = ["veena", "heera", "lekha", "isha", "raveena", "swara", "kalpana", "shruti"];
  const lc = (v) => (v.name || "").toLowerCase();
  const isEnIN = (v) => (v.lang || "").toLowerCase().startsWith("en-in");
  const isFemale = (v) => /female|woman|veena|heera|lekha|isha/i.test(v.name || "");

  return (
    voices.find((v) => knownIndianFemaleNames.some((n) => lc(v).includes(n)))
    || voices.find((v) => isEnIN(v) && isFemale(v))
    || voices.find((v) => isEnIN(v))
    || voices.find((v) => /^en/i.test(v.lang || "") && isFemale(v))
    || voices.find((v) => /^en/i.test(v.lang || ""))
    || voices[0]
  );
}

/**
 * Speak a "you were late" message in an Indian female voice (best-effort).
 * Safe to call even if the browser has no TTS support — it just no-ops.
 * Must be invoked from a user gesture (click) or browsers will block it.
 */
export function speakLateMessage(minutes, memberName) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  // Stop anything already queued (avoids overlap if user taps quickly).
  try { window.speechSynthesis.cancel(); } catch (err) { console.debug("TTS cancel failed (no-op):", err); }

  const speak = () => {
    const voice = pickIndianFemaleVoice();
    let line;
    if (!minutes || minutes < 1) {
      line = memberName
        ? `Hello ${memberName}, you have just checked in. Please try to be early tomorrow.`
        : `You have just checked in. Please try to be early tomorrow.`;
    } else if (minutes < 60) {
      line = memberName
        ? `Hello ${memberName}, you are ${minutes} minute${minutes === 1 ? "" : "s"} late today. Please try to be on time tomorrow.`
        : `You are ${minutes} minute${minutes === 1 ? "" : "s"} late today. Please try to be on time tomorrow.`;
    } else {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const parts = [`${h} hour${h === 1 ? "" : "s"}`];
      if (m) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
      line = memberName
        ? `Hello ${memberName}, you are ${parts.join(" and ")} late today. Please try to be on time tomorrow.`
        : `You are ${parts.join(" and ")} late today. Please try to be on time tomorrow.`;
    }
    const u = new SpeechSynthesisUtterance(line);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang || "en-IN";
    } else {
      u.lang = "en-IN";
    }
    u.rate = 0.95;
    u.pitch = 1.05;
    u.volume = 1;
    try { window.speechSynthesis.speak(u); } catch (err) { console.debug("TTS speak failed (no-op):", err); }
  };

  // Voices may not be loaded yet on first page open; wait for the event.
  // A `done` latch prevents speak() from firing twice if voiceschanged fires
  // after our 800 ms safety timeout has already triggered it.
  const voices = window.speechSynthesis.getVoices();
  if (voices && voices.length > 0) {
    speak();
  } else {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      window.speechSynthesis.removeEventListener("voiceschanged", fire);
      speak();
    };
    window.speechSynthesis.addEventListener("voiceschanged", fire);
    // Safety timeout in case voiceschanged never fires
    setTimeout(fire, 800);
  }
}

