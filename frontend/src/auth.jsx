import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import { api, setToken, clearToken, getToken, clearStaticCache } from "./api";

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
  } catch (err) {
    // Quota exceeded or private-mode block — fall back to no caching, the
    // Login page just won't show the "Welcome back" banner next visit.
    console.debug("rememberLastUser skipped:", err?.message);
  }
}
export function getRememberedUser() {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.debug("getRememberedUser parse failed:", err?.message);
    return null;
  }
}
export function forgetRememberedUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch (err) {
    console.debug("forgetRememberedUser ignored:", err?.message);
  }
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
    clearStaticCache();
    setUser(null);
    // Intentionally KEEP iu_last_user_v1 — the device is still theirs, so the
    // login page shows "Welcome back, NAME" on the next visit. Use the
    // "Not me?" button to clear it.
  }, []);

  const refreshMe = useCallback(async () => {
    if (!getToken()) {
      // Already logged out elsewhere — avoid a stray request that just
      // returns 401 and pollutes the network panel.
      return;
    }
    try {
      const me = await api.get("/auth/me");
      setUser(me);
      rememberLastUser(me);
    } catch (err) {
      console.debug("refreshMe failed (token likely expired):", err?.message);
    }
  }, []);

  // Memoise the context value so consumers of `useAuth()` don't
  // re-render on every provider re-render (7 Jul 2026 code review).
  // `login`, `logout`, `loginWithToken`, `refreshMe` are already
  // stable via `useCallback`; only `user` / `loading` fluctuate.
  const ctxValue = useMemo(
    () => ({ user, loading, login, loginWithToken, logout, refreshMe }),
    [user, loading, login, loginWithToken, logout, refreshMe]
  );

  return (
    <AuthCtx.Provider value={ctxValue}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
