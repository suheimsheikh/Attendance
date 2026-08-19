import axios from "axios";
import { toast } from "sonner";

const BASE = process.env.REACT_APP_BACKEND_URL;
const TOKEN_KEY = "ishowedup_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export const apiUrl = (path) => `${BASE}/api${path}`;

const client = axios.create({ baseURL: `${BASE}/api` });

// Per-tab client id — sent on every request so the meals live-update
// signal can tell which tab originated a change (echo suppression).
export const CLIENT_ID =
  (window.crypto?.randomUUID && window.crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

client.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  cfg.headers["X-Client-Id"] = CLIENT_ID;
  return cfg;
});

export class ApiError extends Error {
  constructor(status, message, requestId) {
    super(message);
    this.status = status;
    // The server echoes the X-Request-ID it logged this call under. Show it
    // in error toasts so coaches can read it back to support over the phone
    // and ops can pull the matching log lines.
    this.requestId = requestId || null;
  }
}

const unwrap = async (p) => {
  try {
    const res = await p;
    return res.data;
  } catch (err) {
    const status = err?.response?.status || 0;
    const msg = err?.response?.data?.detail || err?.message || "Request failed";
    const requestId = err?.response?.headers?.["x-request-id"] || null;
    throw new ApiError(status, typeof msg === "string" ? msg : "Request failed", requestId);
  }
};

export const api = {
  get: (path, params) => unwrap(client.get(path, { params })),
  post: (path, body) => unwrap(client.post(path, body)),
  patch: (path, body) => unwrap(client.patch(path, body)),
  put: (path, body) => unwrap(client.put(path, body)),
  del: (path) => unwrap(client.delete(path)),
};

// -------------------------------------------------------------------------
// Static-config cache (perf pass 24 Feb 2026)
// -------------------------------------------------------------------------
// A handful of endpoints return near-static data — office settings,
// training sites, category master, meal list — but they're fetched on
// every mount of Muster / Meals / Presence / Reports. Cache them at
// the module level with a soft TTL so we hit the server at most once
// every 10 minutes per browser tab.
//
// This is orthogonal to React Query — pages that call `api.get()`
// directly (not via useApiQuery) still get the win. Cache is cleared
// on `clearToken()` / logout so a new user doesn't inherit stale
// office config from the previous session.
const _staticCache = new Map();
const STATIC_TTL_MS = 10 * 60_000;

/** Cached GET for near-static endpoints. Same signature as `api.get`. */
api.getCached = async (path, params) => {
  const key = path + (params ? "?" + JSON.stringify(params) : "");
  const now = Date.now();
  const hit = _staticCache.get(key);
  if (hit && now - hit.at < STATIC_TTL_MS) {
    return hit.value;
  }
  const value = await unwrap(client.get(path, { params }));
  _staticCache.set(key, { value, at: now });
  return value;
};

/** Clear the static-config cache — call on logout / user switch. */
export const clearStaticCache = () => _staticCache.clear();

// Download blob (CSV / PDF / XLSX) keeping auth header
export async function downloadBlob(path, filename, params) {
  const res = await client.get(path, { params, responseType: "blob" });
  // Backend errors come back as JSON or HTML with the wrong status — axios
  // happily wraps them as a blob, so we'd silently save an "error page" as
  // the user's CSV/PDF. Detect the mismatch and surface it.
  const ct = (res.headers?.["content-type"] || "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("text/html")) {
    const text = await res.data.text();
    let msg = text;
    try { msg = JSON.parse(text)?.detail || text; } catch { /* keep raw text */ }
    throw new ApiError(res.status || 0, typeof msg === "string" ? msg : "Download failed");
  }
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

// Surface an ApiError (or any thrown error) as a toast, with the server's
// Request-ID attached as a description so coaches can read it back to
// support when they hit anything weird. Drop-in replacement for
// `toast.error(err?.message || "...")`.
export function showApiError(err, fallback) {
  const msg = err?.message || fallback || "Something went wrong";
  const rid = err?.requestId;
  if (rid) {
    toast.error(msg, { description: `Request ID: ${rid}` });
  } else {
    toast.error(msg);
  }
}


export async function uploadFile(path, file) {
  const form = new FormData();
  form.append("file", file);
  return unwrap(client.post(path, form, { headers: { "Content-Type": "multipart/form-data" } }));
}
