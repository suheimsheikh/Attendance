import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setToken, clearToken, getToken } from "./api";

const AuthCtx = createContext(null);

// Tiny localStorage cache of the last-logged-in member on this device so the
// Login page can greet them with their photo and name. Only full_name + photo
// are stored — no tokens, no IDs.
const LAST_USER_KEY = "iu_last_user_v1";
function rememberLastUser(u) {
  if (!u) return;
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify({
      full_name: u.full_name || "",
      photo: u.photo || "",
    }));
  } catch { /* quota or private mode */ }
}
export function getRememberedUser() {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
export function forgetRememberedUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch { /* ignore */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get("/auth/me");
      setUser(me);
      rememberLastUser(me);
    } catch {
      clearToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  const login = useCallback(async (email, password) => {
    const res = await api.post("/auth/login", { email, password });
    setToken(res.access_token);
    setUser(res.user);
    rememberLastUser(res.user);
    return res.user;
  }, []);

  const loginWithToken = useCallback((token, user) => {
    setToken(token);
    setUser(user);
    rememberLastUser(user);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    // Intentionally KEEP iu_last_user_v1 — the device is still theirs, so the
    // login page shows "Welcome back, NAME" on the next visit. Use the
    // "Not me?" button to clear it.
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const me = await api.get("/auth/me");
      setUser(me);
      rememberLastUser(me);
    } catch (err) {
      console.debug("refreshMe failed (token likely expired):", err?.message);
    }
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, login, loginWithToken, logout, refreshMe }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
