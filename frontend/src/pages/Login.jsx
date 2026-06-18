import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Phone, Mail, Lock, ArrowRight, Loader2, ChevronDown, ChevronUp, Hourglass, RefreshCw, User, Tag } from "lucide-react";
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
  const [needsProfile, setNeedsProfile] = useState(false);  // new-user follow-up form
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
        // First-time, unmatched user — ask for name before sending the request to admin.
        if (res.needs_profile) {
          setNeedsProfile(true);
        } else {
          setPending(true);
          startPolling(deviceId);
          toast.success("Request sent. Awaiting admin approval.");
        }
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
    } catch (err) {
      // Polling: swallow transient errors so we don't spam toasts every 4 seconds.
      console.debug("phone status poll failed:", err?.message);
    }
  };

  const startPolling = (deviceId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => checkStatus(deviceId), 4000);
  };

  const submitProfile = async ({ full_name, rank, category }) => {
    const deviceId = deviceIdRef.current || getDeviceId();
    const info = getDeviceInfo();
    try {
      await api.post("/auth/phone", {
        phone: phone.trim(),
        device_id: deviceId,
        ...info,
        full_name,
        rank: rank || null,
        category,
      });
      setNeedsProfile(false);
      setPending(true);
      startPolling(deviceId);
      toast.success("Thanks! Your request is with the admin.");
    } catch (err) {
      toast.error(err?.message || "Could not send request");
    }
  };

  if (needsProfile) {
    return (
      <Shell>
        <ProfileIntroForm
          phone={phone}
          onSubmit={submitProfile}
          onBack={() => setNeedsProfile(false)}
        />
      </Shell>
    );
  }

  if (pending) {
    return (
      <Shell>
        <div className="text-center" data-testid="pending-approval-panel">
          <div className="mx-auto w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
            <Hourglass className="text-slate-700" />
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900">Waiting for approval</h2>
          <p className="text-slate-500 mt-2 max-w-sm mx-auto">
            Your request has been sent to your admin. As soon as they approve this device, you&apos;ll be signed in automatically.
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
          Enter your phone number — your admin approves your browser once, then you&apos;re in for good.
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
      <div className="hidden md:flex md:w-1/2 relative items-center justify-center p-12 overflow-hidden bg-gradient-to-br from-slate-50 via-sky-50 to-teal-50">
        <div className="relative z-10 max-w-md w-full bg-white rounded-2xl p-8 shadow-xl ring-1 ring-slate-200">
          <img src="/yc-logo.png" alt="The Yacht Club of Hyderabad" className="w-full h-auto" />
          <p className="mt-4 text-slate-600 text-sm text-center font-medium">Campus presence &amp; duty tracking</p>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 md:p-12 bg-white">
        <div className="w-full max-w-sm">
          <div className="md:hidden flex items-center gap-3 mb-6">
            <img src="/favicon.png" alt="YCH" className="w-10 h-10 rounded-xl object-contain" />
            <span className="font-extrabold text-xl leading-tight">Yacht Club<br/><span className="text-sm font-semibold text-slate-500">of Hyderabad</span></span>
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

function ProfileIntroForm({ phone, onSubmit, onBack }) {
  const [fullName, setFullName] = useState("");
  const [rank, setRank] = useState("");
  const [category, setCategory] = useState("athlete");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (fullName.trim().length < 2) {
      toast.error("Please enter your full name");
      return;
    }
    setBusy(true);
    try { await onSubmit({ full_name: fullName.trim(), rank: rank.trim(), category }); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="profile-intro-panel">
      <h2 className="text-3xl font-extrabold tracking-tight">Welcome aboard</h2>
      <p className="text-slate-500 mt-2 text-sm">
        We don&apos;t recognise <span className="font-semibold text-slate-700">{phone}</span> yet. Tell us a bit about yourself so your admin can approve you quickly.
      </p>

      <form onSubmit={submit} className="mt-7 space-y-4">
        <div>
          <label className="iu-label">Full name</label>
          <div className="relative">
            <User size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              data-testid="profile-fullname-input"
              autoFocus
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Suraj Verma"
              className="iu-input pl-10"
              autoComplete="name"
            />
          </div>
        </div>
        <div>
          <label className="iu-label">Rank / Title <span className="text-slate-400 normal-case font-normal">(optional)</span></label>
          <div className="relative">
            <Tag size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              data-testid="profile-rank-input"
              value={rank}
              onChange={(e) => setRank(e.target.value)}
              placeholder="e.g. Petty Officer"
              className="iu-input pl-10"
            />
          </div>
        </div>
        <div>
          <label className="iu-label">Category</label>
          <div className="grid grid-cols-3 gap-2" data-testid="profile-category-row">
            {["athlete", "staff", "coach"].map((c) => (
              <button
                key={c}
                type="button"
                data-testid={`profile-category-${c}`}
                onClick={() => setCategory(c)}
                className={`iu-btn ${category === c ? "iu-btn-primary" : "iu-btn-secondary"} capitalize !h-10`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onBack} className="iu-btn-secondary flex-1" data-testid="profile-back-button">
            Back
          </button>
          <button data-testid="profile-submit-button" type="submit" disabled={busy} className="iu-btn-primary flex-1">
            {busy ? <Loader2 className="animate-spin" size={16} /> : <>Send request <ArrowRight size={16} /></>}
          </button>
        </div>
      </form>
    </div>
  );
}
