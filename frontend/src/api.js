import axios from "axios";

const BASE = process.env.REACT_APP_BACKEND_URL;
const TOKEN_KEY = "ishowedup_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export const apiUrl = (path) => `${BASE}/api${path}`;

const client = axios.create({ baseURL: `${BASE}/api` });

client.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
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

export async function uploadFile(path, file) {
  const form = new FormData();
  form.append("file", file);
  return unwrap(client.post(path, form, { headers: { "Content-Type": "multipart/form-data" } }));
}
