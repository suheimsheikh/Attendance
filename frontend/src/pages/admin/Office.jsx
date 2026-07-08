import React, { useEffect, useState } from "react";
import { Loader2, Save, MapPin, MessageSquare, Phone, KeyRound, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { getLocation } from "../../utils";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";

const TZS = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

// Categories the per-category Leave-notice rule applies to. Mirrors
// the backend OfficeConfig validator. Default to 3 days if unset.
const LEAVE_CATS = [
  { key: "athlete",   label: "Athlete" },
  { key: "staff",     label: "Staff" },
  { key: "coach",     label: "Coach" },
  { key: "executive", label: "Executive" },
];

/**
 * Coerce whatever shape `leave_notice_days` arrived in (legacy int,
 * partial dict, missing, or full dict) into a safe `{cat: int}` payload
 * with every category populated. Default per-cat is 3.
 */
function _normLeaveNoticeDays(v) {
  const out = { athlete: 3, staff: 3, coach: 3, executive: 3 };
  if (v == null) return out;
  if (typeof v === "number") {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    return { athlete: n, staff: n, coach: n, executive: n };
  }
  if (typeof v === "object") {
    for (const c of Object.keys(out)) {
      const raw = v[c];
      const n = Number(raw);
      out[c] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
    }
  }
  return out;
}

// Polly voices that support both en-IN and te-IN. Aditi is the safe default.
const VOICES = ["Polly.Aditi", "Polly.Raveena", "Polly.Kajal-Neural"];
const LANG_EN = ["en-IN", "en-US", "en-GB"];
const LANG_TE = ["te-IN"];

const TEMPLATE_FIELDS = [
  { key: "late_en",   label: "Parent SMS — child is late (English)",   long: true },
  { key: "late_te",   label: "Parent SMS — child is late (Telugu)",    long: true },
  { key: "absent_en", label: "Parent SMS — child is absent (English)", long: true },
  { key: "absent_te", label: "Parent SMS — child is absent (Telugu)",  long: true },
  { key: "voice_en",  label: "Voice call message (English)",           long: true },
  { key: "voice_te",  label: "Voice call message (Telugu)",            long: true },
];

export default function OfficeSettings() {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const formErr = useFormError();

  useEffect(() => {
    (async () => {
      try { setForm(await api.get("/office")); }
      finally { setLoading(false); }
    })();
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const pickHere = async () => {
    setPicking(true);
    try {
      const loc = await getLocation();
      set("latitude", Number(loc.latitude.toFixed(6)));
      set("longitude", Number(loc.longitude.toFixed(6)));
      toast.success("Captured your current GPS position");
    } catch (err) { toast.error(err.message); }
    finally { setPicking(false); }
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    formErr.clear();
    try {
      const body = {
        name: form.name || "Campus Office",
        latitude: Number(form.latitude),
        longitude: Number(form.longitude),
        radius_m: Number(form.radius_m),
        default_work_start: form.default_work_start || "09:00",
        default_work_end: form.default_work_end || "17:00",
        timezone: form.timezone || "Asia/Kolkata",
        late_grace_minutes: Number(form.late_grace_minutes || 0),
        parent_notify_grace_minutes: Number(form.parent_notify_grace_minutes ?? 30),
        default_weekly_off: form.default_weekly_off || "sunday",
        leave_notice_days: _normLeaveNoticeDays(form.leave_notice_days),
        half_day_fn_start: form.half_day_fn_start || "09:30",
        half_day_fn_end:   form.half_day_fn_end   || "13:30",
        half_day_pn_start: form.half_day_pn_start || "13:30",
        half_day_pn_end:   form.half_day_pn_end   || "18:00",
        meal_breakfast_cutoff: form.meal_breakfast_cutoff || "07:00",
        checkout_reminder_enabled: form.checkout_reminder_enabled !== false,
        checkout_reminder_time: form.checkout_reminder_time || "20:00",
        checkout_reminder_template: form.checkout_reminder_template || "Hi {name}, looks like you're still checked in at {academy}. Please check out via the app when you leave.",
      };
      const updated = await api.put("/office", body);
      setForm(updated);
      toast.success("Office settings saved");
    } catch (err) { formErr.setFromApi(err, "Failed to save office settings"); }
    finally { setSaving(false); }
  };

  if (loading || !form) return <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin mx-auto"/></div>;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Office Settings</h1>
        <p className="text-slate-500 text-sm mt-1">Geofence, work hours, and timezone.</p>
      </header>

      <form onSubmit={save} className="iu-card p-5 md:p-6 space-y-4" data-testid="office-form">
        <div>
          <label className="iu-label">Office name</label>
          <input data-testid="of-name" value={form.name || ""} onChange={(e) => set("name", e.target.value)} className="iu-input" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Latitude</label>
            <input data-testid="of-lat" type="number" step="any" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">Longitude</label>
            <input data-testid="of-lng" type="number" step="any" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} className="iu-input" />
          </div>
        </div>
        <button type="button" data-testid="of-here" onClick={pickHere} disabled={picking} className="iu-btn-secondary">
          {picking ? <Loader2 className="animate-spin" size={14}/> : <MapPin size={14}/>} Use my current location
        </button>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Geofence radius (m)</label>
            <input data-testid="of-radius" type="number" min="20" max="2000" value={form.radius_m} onChange={(e) => set("radius_m", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">Late grace (min)</label>
            <input data-testid="of-grace" type="number" min="0" max="120" value={form.late_grace_minutes || 0} onChange={(e) => set("late_grace_minutes", e.target.value)} className="iu-input" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Default work start</label>
            <input data-testid="of-start" type="time" value={form.default_work_start || "09:00"} onChange={(e) => set("default_work_start", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">Default work end</label>
            <input data-testid="of-end" type="time" value={form.default_work_end || "17:00"} onChange={(e) => set("default_work_end", e.target.value)} className="iu-input" />
          </div>
        </div>

        <div>
          <label className="iu-label">Timezone</label>
          <select data-testid="of-tz" value={form.timezone || "Asia/Kolkata"} onChange={(e) => set("timezone", e.target.value)} className="iu-input">
            {TZS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div>
          <label className="iu-label">Notify parents after (minutes past work start)</label>
          <input
            data-testid="of-parent-notify-grace"
            type="number"
            min={0}
            max={240}
            value={form.parent_notify_grace_minutes ?? 30}
            onChange={(e) => set("parent_notify_grace_minutes", e.target.value)}
            className="iu-input"
          />
          <p className="text-[11px] text-slate-500 mt-1">How long after an athlete&apos;s work start time before the &quot;Notify parents&quot; button appears on the Presence Board. Default 30 minutes.</p>
        </div>

        <div>
          <label className="iu-label">Default weekly off</label>
          <select
            data-testid="of-default-weekly-off"
            value={form.default_weekly_off || "sunday"}
            onChange={(e) => set("default_weekly_off", e.target.value)}
            className="iu-input"
          >
            <option value="monday">Monday</option>
            <option value="tuesday">Tuesday</option>
            <option value="wednesday">Wednesday</option>
            <option value="thursday">Thursday</option>
            <option value="friday">Friday</option>
            <option value="saturday">Saturday</option>
            <option value="sunday">Sunday</option>
          </select>
          <p className="text-[11px] text-slate-500 mt-1">
            Used as the fallback when a member&apos;s own weekly off isn&apos;t set on their profile. Drives
            comp-off accrual: attending on this day earns +1 comp-off credit, which they can later spend
            via the Comp Off leave type. Member-level weekly off (if set) always overrides this default.
          </p>
        </div>

        <div>
          <label className="iu-label">Leave notice (days) — per category</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {LEAVE_CATS.map((cat) => {
              const cur = _normLeaveNoticeDays(form.leave_notice_days)[cat.key];
              return (
                <div key={cat.key}>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">
                    {cat.label}
                  </label>
                  <input
                    data-testid={`of-leave-notice-${cat.key}`}
                    type="number"
                    min={0}
                    max={30}
                    value={cur}
                    onChange={(e) => {
                      const next = _normLeaveNoticeDays(form.leave_notice_days);
                      next[cat.key] = Math.max(0, Math.floor(Number(e.target.value) || 0));
                      set("leave_notice_days", next);
                    }}
                    className="iu-input"
                  />
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Minimum calendar days of advance notice for a member to self-apply a <strong>Leave</strong>,
            evaluated against the member&apos;s own category. Tours, postings and late-coming are exempt.
            Admins filing on behalf bypass this gate (so genuine emergencies can still be recorded).
            Set any category to <strong>0</strong> to disable the rule for that group. Missing values default to <strong>3</strong>.
          </p>
        </div>

        <div>
          <label className="iu-label">Half-day leave windows</label>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-slate-200 p-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">Forenoon (FN)</div>
              <div className="flex items-center gap-2">
                <input
                  data-testid="of-halfday-fn-start"
                  type="time"
                  value={form.half_day_fn_start || "09:30"}
                  onChange={(e) => set("half_day_fn_start", e.target.value)}
                  className="iu-input"
                />
                <span className="text-slate-400 text-xs">to</span>
                <input
                  data-testid="of-halfday-fn-end"
                  type="time"
                  value={form.half_day_fn_end || "13:30"}
                  onChange={(e) => set("half_day_fn_end", e.target.value)}
                  className="iu-input"
                />
              </div>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">Postnoon (PN)</div>
              <div className="flex items-center gap-2">
                <input
                  data-testid="of-halfday-pn-start"
                  type="time"
                  value={form.half_day_pn_start || "13:30"}
                  onChange={(e) => set("half_day_pn_start", e.target.value)}
                  className="iu-input"
                />
                <span className="text-slate-400 text-xs">to</span>
                <input
                  data-testid="of-halfday-pn-end"
                  type="time"
                  value={form.half_day_pn_end || "18:00"}
                  onChange={(e) => set("half_day_pn_end", e.target.value)}
                  className="iu-input"
                />
              </div>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Clock windows shown on the Apply Leave form when a member (or admin) picks half-day.
            The balance ladder always deducts <strong>0.5 days</strong> regardless of these times —
            they are informational only. Defaults: FN 09:30–13:30, PN 13:30–18:00.
          </p>
        </div>

        <div>
          <label className="iu-label" htmlFor="of-meal-cutoff">Breakfast eligibility cut-off</label>
          <div className="flex items-center gap-2 max-w-xs">
            <input
              id="of-meal-cutoff"
              data-testid="of-meal-breakfast-cutoff"
              type="time"
              value={form.meal_breakfast_cutoff || "07:00"}
              onChange={(e) => set("meal_breakfast_cutoff", e.target.value)}
              className="iu-input"
            />
            <span className="text-xs text-slate-500">office-local</span>
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Members must be checked in on or before this time to be counted on the
            <strong> Chef&apos;s View</strong> for breakfast. Tune tighter (e.g. 06:45)
            on regatta days when the kitchen leaves early. Default: <strong>07:00</strong>.
          </p>
        </div>

        <div className="border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between mb-2">
            <label className="iu-label !m-0">Forgot-to-check-out SMS reminder</label>
            <label className="inline-flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                data-testid="of-checkout-reminder-enabled"
                checked={form.checkout_reminder_enabled !== false}
                onChange={(e) => set("checkout_reminder_enabled", e.target.checked)}
              />
              <span className="font-semibold">Enabled</span>
            </label>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <label className="iu-label">Send time</label>
              <input
                data-testid="of-checkout-reminder-time"
                type="time"
                value={form.checkout_reminder_time || "20:00"}
                onChange={(e) => set("checkout_reminder_time", e.target.value)}
                disabled={form.checkout_reminder_enabled === false}
                className="iu-input"
              />
            </div>
            <div className="md:col-span-2">
              <label className="iu-label">Message template</label>
              <input
                data-testid="of-checkout-reminder-template"
                value={form.checkout_reminder_template || ""}
                onChange={(e) => set("checkout_reminder_template", e.target.value)}
                disabled={form.checkout_reminder_enabled === false}
                placeholder="Hi {name}, you're still checked in at {academy}..."
                className="iu-input"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            <p className="text-[11px] text-slate-500">
              Placeholders <code>{"{name}"}</code> and <code>{"{academy}"}</code> are filled per-member. Only sent once per day per session.
            </p>
            <button
              type="button"
              data-testid="of-checkout-reminder-test"
              onClick={async () => {
                try {
                  const res = await api.post("/admin/checkout-reminder/send-now");
                  toast.success(`Reminder batch fired — ${res.sent} SMS sent`);
                } catch (err) { toast.error(err?.message || "Send failed"); }
              }}
              className="iu-btn-secondary !text-xs"
            >
              Send now (test)
            </button>
          </div>
        </div>

        <FormErrorBanner
          error={formErr.error}
          requestId={formErr.requestId}
          onDismiss={formErr.clear}
          testId="of-save-error"
        />
        <button data-testid="of-save" disabled={saving} className="iu-btn-primary w-full">
          {saving ? <Loader2 className="animate-spin" size={16}/> : <><Save size={16}/> Save settings</>}
        </button>
      </form>

      <TwilioPanel />
    </div>
  );
}


/**
 * Twilio configuration card — credentials, default sender number, bilingual
 * message templates, and test buttons. Lives inside Office Settings so admins
 * have a single screen for all academy-wide configuration.
 *
 * Auth token is NEVER returned in plaintext from the backend — GET shows a
 * masked dot-string. Admins click "Change token" to enter a new one. A blank
 * token field on save is treated as "leave existing token untouched".
 */
function TwilioPanel() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editToken, setEditToken] = useState(false);
  const [newToken, setNewToken] = useState("");
  const [testTo, setTestTo] = useState("");
  const [busyTest, setBusyTest] = useState(null);
  // Single banner above the Save row so any Twilio failure (save, send-test
  // SMS, send-test voice) lands within the user's line of sight, instead
  // of as a top-of-screen toast they have to scroll up to see.
  const formErr = useFormError();

  const load = async () => {
    setLoading(true);
    try { setCfg(await api.get("/sms/config")); }
    catch (err) { toast.error(err?.message || "Failed to load Twilio config"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));
  const setTpl = (k, v) => setCfg((c) => ({ ...c, templates: { ...(c.templates || {}), [k]: v } }));

  const save = async () => {
    setSaving(true);
    formErr.clear();
    try {
      const body = {
        enabled: !!cfg.enabled,
        account_sid: cfg.account_sid || "",
        messaging_service_sid: cfg.messaging_service_sid || "",
        default_from_number: cfg.default_from_number || "",
        voice_language_en: cfg.voice_language_en || "en-IN",
        voice_language_te: cfg.voice_language_te || "te-IN",
        voice_voice_en: cfg.voice_voice_en || "Polly.Aditi",
        voice_voice_te: cfg.voice_voice_te || "Polly.Aditi",
        templates: cfg.templates || {},
      };
      // Send the auth token whenever the input is currently being shown AND
      // the admin typed something in it. The input is shown either when the
      // admin clicked "Change token" (editToken=true) OR during first-time
      // setup when no token is saved yet (has_auth_token=false) — in the
      // latter case `editToken` is still false even though the user is
      // clearly entering a fresh token, so we must accept that path too.
      const tokenInputVisible = editToken || !cfg.has_auth_token;
      if (tokenInputVisible && newToken.trim()) body.auth_token = newToken.trim();
      await api.put("/sms/config", body);
      toast.success("Twilio settings saved");
      setEditToken(false); setNewToken("");
      load();
    } catch (err) { formErr.setFromApi(err, "Failed to save Twilio settings"); }
    finally { setSaving(false); }
  };

  const sendTestSms = async () => {
    const to = (testTo || "").trim();
    if (!to.startsWith("+")) { formErr.setMessage("Use E.164 format, e.g. +91XXXXXXXXXX"); return; }
    setBusyTest("sms");
    formErr.clear();
    try {
      const res = await api.post("/sms/test", { to });
      toast.success(`SMS queued (sid: ${res.twilio_sid?.slice(-6)})`);
    } catch (err) { formErr.setFromApi(err, "Test SMS failed"); }
    finally { setBusyTest(null); }
  };

  const sendTestVoice = async () => {
    const to = (testTo || "").trim();
    if (!to.startsWith("+")) { formErr.setMessage("Use E.164 format, e.g. +91XXXXXXXXXX"); return; }
    setBusyTest("voice");
    formErr.clear();
    try {
      const res = await api.post("/sms/voice/test", { to });
      toast.success(`Voice call queued (sid: ${res.twilio_sid?.slice(-6)})`);
    } catch (err) { formErr.setFromApi(err, "Test voice call failed"); }
    finally { setBusyTest(null); }
  };

  if (loading || !cfg) {
    return <div className="iu-card p-6 mt-6 text-center text-slate-400"><Loader2 className="animate-spin mx-auto"/></div>;
  }

  return (
    <div className="iu-card p-5 md:p-6 mt-6 space-y-5" data-testid="twilio-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
            <MessageSquare size={18} className="text-emerald-600" /> Twilio — Parent SMS &amp; Voice
          </h2>
          <p className="text-slate-500 text-sm mt-1">SMS &amp; voice notifications to parents and guardians, in English and Telugu. Per-institution sender numbers are configured in <strong>Institutions</strong>.</p>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer select-none shrink-0">
          <input
            data-testid="tw-enabled"
            type="checkbox"
            checked={!!cfg.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
            className="w-4 h-4 accent-emerald-600"
          />
          <span className="text-sm font-semibold">{cfg.enabled ? "Enabled" : "Disabled"}</span>
        </label>
      </div>

      {/* ──────────── Credentials ──────────── */}
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <label className="iu-label">Account SID</label>
          <input
            data-testid="tw-sid"
            value={cfg.account_sid || ""}
            onChange={(e) => set("account_sid", e.target.value)}
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className="iu-input font-mono text-xs"
          />
        </div>
        <div>
          <label className="iu-label flex items-center justify-between">
            <span>Auth Token</span>
            {cfg.has_auth_token && !editToken && (
              <button
                type="button"
                onClick={() => { setEditToken(true); setNewToken(""); }}
                className="text-[11px] text-amber-700 underline"
              >
                Change token
              </button>
            )}
          </label>
          {editToken || !cfg.has_auth_token ? (
            <input
              data-testid="tw-token"
              type="password"
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
              placeholder="Enter new Twilio auth token"
              className="iu-input font-mono text-xs"
              autoComplete="off"
            />
          ) : (
            <div className="iu-input font-mono text-xs bg-slate-50 text-slate-500 flex items-center gap-2">
              <KeyRound size={14} /> {cfg.auth_token || "•••••"}
            </div>
          )}
        </div>
        <div>
          <label className="iu-label">Default &quot;From&quot; number</label>
          <input
            data-testid="tw-from"
            value={cfg.default_from_number || ""}
            onChange={(e) => set("default_from_number", e.target.value)}
            placeholder="+15551234567 (E.164)"
            className="iu-input font-mono text-xs"
          />
          <p className="text-[11px] text-slate-500 mt-1">Used when an institution has no sender number of its own.</p>
        </div>
        <div>
          <label className="iu-label">Messaging Service SID (optional)</label>
          <input
            data-testid="tw-msvc"
            value={cfg.messaging_service_sid || ""}
            onChange={(e) => set("messaging_service_sid", e.target.value)}
            placeholder="MGxxxxxxxx (preferred for Indian DLT)"
            className="iu-input font-mono text-xs"
          />
          <p className="text-[11px] text-slate-500 mt-1">Recommended for Indian DLT — handles sender rotation, delivery webhooks, opt-outs.</p>
        </div>
      </div>

      {/* ──────────── Voice settings ──────────── */}
      <div className="grid md:grid-cols-4 gap-4 pt-2 border-t border-slate-200">
        <div>
          <label className="iu-label">Voice (English)</label>
          <select className="iu-input" value={cfg.voice_voice_en || "Polly.Aditi"} onChange={(e) => set("voice_voice_en", e.target.value)} data-testid="tw-voice-en">
            {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="iu-label">Voice language (EN)</label>
          <select className="iu-input" value={cfg.voice_language_en || "en-IN"} onChange={(e) => set("voice_language_en", e.target.value)}>
            {LANG_EN.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="iu-label">Voice (Telugu)</label>
          <select className="iu-input" value={cfg.voice_voice_te || "Polly.Aditi"} onChange={(e) => set("voice_voice_te", e.target.value)} data-testid="tw-voice-te">
            {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label className="iu-label">Voice language (TE)</label>
          <select className="iu-input" value={cfg.voice_language_te || "te-IN"} onChange={(e) => set("voice_language_te", e.target.value)}>
            {LANG_TE.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* ──────────── Templates ──────────── */}
      <div className="pt-2 border-t border-slate-200 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-bold text-slate-700">Message templates</div>
          <div className="text-[11px] text-slate-500">Use <code className="px-1 bg-slate-100 rounded">{"{name}"}</code> for child first name, <code className="px-1 bg-slate-100 rounded">{"{academy}"}</code> for office name.</div>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {TEMPLATE_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="iu-label">{f.label}</label>
              <textarea
                data-testid={`tw-tpl-${f.key}`}
                value={(cfg.templates || {})[f.key] || ""}
                onChange={(e) => setTpl(f.key, e.target.value)}
                className="iu-input"
                rows={f.long ? 3 : 2}
              />
            </div>
          ))}
        </div>
      </div>

      {/* ──────────── Test panel ──────────── */}
      <div className="pt-2 border-t border-slate-200 space-y-3">
        <div className="text-sm font-bold text-slate-700">Send test</div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="iu-label">Test number (E.164)</label>
            <input
              data-testid="tw-test-to"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="+91XXXXXXXXXX"
              className="iu-input font-mono text-xs"
            />
          </div>
          <button
            type="button"
            data-testid="tw-test-sms"
            onClick={sendTestSms}
            disabled={busyTest !== null || !cfg.enabled}
            className="iu-btn-primary"
          >
            {busyTest === "sms" ? <Loader2 className="animate-spin" size={14}/> : <><MessageSquare size={14}/> Test SMS</>}
          </button>
          <button
            type="button"
            data-testid="tw-test-voice"
            onClick={sendTestVoice}
            disabled={busyTest !== null || !cfg.enabled}
            className="inline-flex items-center gap-2 px-3 h-10 rounded-lg border-2 border-emerald-500 text-emerald-700 font-semibold hover:bg-emerald-50"
          >
            {busyTest === "voice" ? <Loader2 className="animate-spin" size={14}/> : <><Phone size={14}/> Test voice</>}
          </button>
        </div>
        {!cfg.enabled && <p className="text-[11px] text-amber-700">Twilio is currently disabled — enable above and save before sending tests.</p>}
      </div>

      <div className="flex flex-col gap-2 pt-3 border-t border-slate-200">
        <FormErrorBanner
          error={formErr.error}
          requestId={formErr.requestId}
          onDismiss={formErr.clear}
          testId="tw-save-error"
        />
        <div className="flex gap-2">
          <button data-testid="tw-save" onClick={save} disabled={saving} className="iu-btn-primary">
            {saving ? <Loader2 className="animate-spin" size={16}/> : <><Save size={16}/> Save Twilio settings</>}
          </button>
          <button type="button" onClick={load} className="inline-flex items-center gap-2 px-3 h-10 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50" title="Reload from server">
            <RefreshCw size={14}/> Reload
          </button>
        </div>
      </div>
    </div>
  );
}
