import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, saveToken, clearToken } from "@/src/api/client";

export type User = {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "member";
  category: "sailor" | "staff" | "coach";
  rank?: string | null;
  photo?: string | null;
};

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithToken: (token: string, u: User) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (u: User) => void;
  viewAsMember: boolean;
  setViewAsMember: (v: boolean) => void;
  effectiveRole: "admin" | "member";
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAsMember, setViewAsMember] = useState(false);

  const bootstrap = useCallback(async () => {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const login = async (email: string, password: string) => {
    const res = await api.post<{ access_token: string; user: User }>("/auth/login", {
      email,
      password,
    });
    await saveToken(res.access_token);
    setViewAsMember(false);
    setUser(res.user);
  };

  const loginWithToken = async (token: string, u: User) => {
    await saveToken(token);
    setViewAsMember(false);
    setUser(u);
  };

  const logout = async () => {
    await clearToken();
    setViewAsMember(false);
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {}
  };

  const effectiveRole: "admin" | "member" =
    user && user.role === "admin" && viewAsMember ? "member" : user?.role ?? "member";

  return (
    <AuthContext.Provider
      value={{ user, loading, login, loginWithToken, logout, refreshUser, setUser, viewAsMember, setViewAsMember, effectiveRole }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
};
