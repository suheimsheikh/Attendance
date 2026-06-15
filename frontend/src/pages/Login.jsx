import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Anchor, Phone, Mail, Lock, ArrowRight, Loader2, ChevronDown, ChevronUp, Hourglass, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth";
import { api, ApiError, setToken } from "../api";
import { getDeviceId, getDeviceInfo } from "../utils";

export default function Login() {
  const nav = useNavigate();
  const { login, loginWithToken, user } = useAuth();
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const pollRef = useRef(null);
  const deviceIdRef = useRef("");

  useEffect(() => { if (user) nav("/", { replace: true }); }, [user, nav]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const enter = (token, u) => {
    if (pollRef.current) clearInterval(pollRef.current);
    setToken(token);
    loginWithToken(token, u);
    nav("/", { replace: true });
  };

  const submitPhone = async (e) => {
    e?.preventDefault?.();
    if (phone.replace(/[^0-9]/g, "").length < 6) {
      toast.error("Enter a valid phone number");
      return;
    }
    setLoading(true);
    try {
      const deviceId = getDeviceId();
      deviceIdRef.current = deviceId;
      const info = getDeviceInfo();
      const res = await api.post("/auth/phone", { phone: phone.trim(), device_id: deviceId, ...info });
      if (res.status === "approved" && res.access_token && res.user) {
        enter(res.access_token, res.user);
      } else if (res.status === "pending") {
        setPending(true);
        startPolling(deviceId);
        toast.success("Request sent. Awaiting admin approval.");
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not connect");
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async (deviceId) => {
    try {
      const res = await api.get(`/auth/phone/status`, { device_id: deviceId });
      if (res.status === "approved" && res.access_token && res.user) {
        enter(res.access_token, res.user);
      } else if (res.status === "revoked") {
        if (pollRef.current) clearInterval(pollRef.current);
        setPending(false);
        toast.error("This device was revoked. Contact your admin.");
      }
    } catch {}
  };

  const startPolling = (deviceId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => checkStatus(deviceId), 4000);
  };

  if (pending) {
    return (
      <Shell>
        <div className="text-center" data-testid="pending-approval-panel">
          <div className="mx-auto w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
            <Hourglass className="text-slate-700" />
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900">Waiting for approval</h2>
          <p className="text-slate-500 mt-2 max-w-sm mx-auto">
            Your request has been sent to your admin. As soon as they approve this device, you'll be signed in automatically.
          </p>
          <div className="flex items-center justify-center gap-2 my-6 text-slate-400">
            <Loader2 className="animate-spin" size={18} /> Checking…
          </div>
          <button
            data-testid="check-now-button"
            onClick={() => checkStatus(deviceIdRef.current)}
            className="iu-btn-secondary mx-auto"
          >
            <RefreshCw size={14} /> Check now
          </button>
          <button
            data-testid="cancel-pending-button"
            onClick={() => { if (pollRef.current) clearInterval(pollRef.current); setPending(false); }}
            className="block mx-auto mt-4 text-sm text-slate-500 underline hover:text-slate-700"
          >
            Use a different number
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div>
        <h2 className="text-3xl font-extrabold tracking-tight">Sign in</h2>
        <p className="text-slate-500 mt-2 text-sm">
          Enter your phone number — your admin approves your browser once, then you're in for good.
        </p>

        <form onSubmit={submitPhone} className="mt-7 space-y-4">
          <div>
            <label className="iu-label">Phone number</label>
            <div className="relative">
              <Phone size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                data-testid="login-phone-input"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="98765 43210"
                className="iu-input pl-10"
                autoComplete="tel"
              />
            </div>
          </div>
          <button
            type="submit"
            data-testid="phone-continue-button"
            disabled={loading}
            className="iu-btn-primary w-full"
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : <>Continue <ArrowRight size={16} /></>}
          </button>
        </form>

        <button
          data-testid="toggle-admin-login"
          onClick={() => setShowAdmin((s) => !s)}
          className="mt-7 mx-auto flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-900"
        >
          {showAdmin ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          Admin sign in with email
        </button>

        {showAdmin && <AdminEmailForm onLogin={login} onDone={() => nav("/", { replace: true })} />}
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex">
      <div className="hidden md:flex md:w-1/2 relative items-end p-12 text-white overflow-hidden">
        <div className="absolute inset-0 bg-cover bg-center" style={{
          backgroundImage: "url('https://images.unsplash.com/photo-1689846136233-de0717f3675c?crop=entropy&cs=srgb&fm=jpg&w=1600&q=85')"
        }} />
        <div className="absolute inset-0" style={{
          background: "linear-gradient(180deg, rgba(15,23,42,0.35) 0%, rgba(15,23,42,0.75) 60%, #0F172A 100%)"
        }} />
        <div className="relative z-10 max-w-sm">
          <div className="w-12 h-12 rounded-xl bg-white/15 flex items-center justify-center mb-4">
            <Anchor />
          </div>
          <h1 className="text-4xl font-extrabold leading-tight">I Showed Up</h1>
          <p className="mt-3 text-white/80 text-lg">Campus presence & duty tracking — now in your browser.</p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 md:p-12 bg-white">
        <div className="w-full max-w-sm">
          <div className="md:hidden flex items-center gap-2 mb-6">
            <div className="w-10 h-10 rounded-xl bg-slate-900 text-white flex items-center justify-center"><Anchor size={18}/></div>
            <span className="font-extrabold text-xl">I Showed Up</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function AdminEmailForm({ onLogin, onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onLogin(email.trim().toLowerCase(), password);
      onDone();
    } catch (err) {
      toast.error(err?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-100 space-y-3" data-testid="admin-email-form">
      <div>
        <label className="iu-label">Admin email</label>
        <div className="relative">
          <Mail size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="login-email-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@attendance.app"
            className="iu-input pl-10"
          />
        </div>
      </div>
      <div>
        <label className="iu-label">Password</label>
        <div className="relative">
          <Lock size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="login-password-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="iu-input pl-10"
          />
        </div>
      </div>
      <button data-testid="login-submit-button" type="submit" disabled={loading} className="iu-btn-primary w-full">
        {loading ? <Loader2 className="animate-spin" size={16} /> : "Sign in"}
      </button>
    </form>
  );
}
