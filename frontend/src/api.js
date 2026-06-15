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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const unwrap = async (p) => {
  try {
    const res = await p;
    return res.data;
  } catch (err) {
    const status = err?.response?.status || 0;
    const msg = err?.response?.data?.detail || err?.message || "Request failed";
    throw new ApiError(status, typeof msg === "string" ? msg : "Request failed");
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
