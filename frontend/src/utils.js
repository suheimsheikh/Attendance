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

export function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

/**
 * Format a date as `dd/mm/yy` — always shows the 2-digit year. Used in
 * contexts where the year might differ (Profile session history, headers).
 */
export function formatDate(d) {
  if (!d) return "";
  try {
    const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T00:00:00") : new Date(d);
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yy = String(date.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  } catch { return d; }
}

/**
 * Compact `dd/mm` — strips the year when it matches the current calendar
 * year (the common case), otherwise falls back to `dd/mm/yy`. Used in
 * leave / report ranges that almost always sit inside the current year.
 */
export function shortDate(d) {
  if (!d) return "";
  try {
    const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T00:00:00") : new Date(d);
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return sameYear ? `${dd}/${mm}` : `${dd}/${mm}/${String(date.getFullYear()).slice(-2)}`;
  } catch { return d; }
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

export function todayIso() {
  const d = new Date();
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

