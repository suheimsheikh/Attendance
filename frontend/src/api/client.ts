import { storage } from "@/src/utils/storage";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const TOKEN_KEY = "attendance_token";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await storage.secureGet<string>(TOKEN_KEY, "");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function saveToken(token: string) {
  await storage.secureSet(TOKEN_KEY, token);
}

export async function clearToken() {
  await storage.secureRemove(TOKEN_KEY);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
    ...(await authHeader()),
  };
  const res = await fetch(`${BASE}/api${path}`, { ...options, headers });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {}
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text() as unknown as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
};

// Build a full URL for export downloads (with token in header handled by caller)
export function exportUrl(path: string): string {
  return `${BASE}/api${path}`;
}

export async function getAuthHeaderForExport(): Promise<Record<string, string>> {
  return authHeader();
}

// ---- Web-only helpers (used by the desktop console) ----
export async function downloadFileWeb(path: string, filename: string): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(`${BASE}/api${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status, "Download failed");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function uploadFileWeb<T>(path: string, file: File): Promise<T> {
  const headers = await authHeader();
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/api${path}`, { method: "POST", headers, body: form });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.detail || "Upload failed");
  return data;
}
