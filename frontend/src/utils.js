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

export function formatDate(d) {
  if (!d) return "";
  try {
    const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T00:00:00") : new Date(d);
    return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  } catch { return d; }
}

export function shortDate(d) {
  if (!d) return "";
  try {
    const date = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T00:00:00") : new Date(d);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch { return d; }
}

export function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase();
}

export async function getLocation(timeout = 12000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported in this browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      (err) => {
        const msg = err.code === 1 ? "Location permission denied — enable it in your browser settings." :
                    err.code === 2 ? "Position unavailable — try moving outdoors or onto Wi-Fi." :
                    err.code === 3 ? "Location request timed out." : (err.message || "Could not get location");
        reject(new Error(msg));
      },
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
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
  return { sailor: "Sailor", staff: "Staff", coach: "Coach" }[cat] || cat;
}

export const statusConfig = {
  on_campus: { label: "On Campus", color: "#10B981", bg: "rgba(16,185,129,0.12)", icon: "checkmark" },
  on_tour:   { label: "On Tour",   color: "#F97316", bg: "rgba(249,115,22,0.12)", icon: "plane" },
  on_leave:  { label: "On Leave",  color: "#F59E0B", bg: "rgba(245,158,11,0.12)", icon: "bed" },
  exited:    { label: "Exited",    color: "#6B7280", bg: "rgba(107,114,128,0.12)", icon: "exit" },
};
