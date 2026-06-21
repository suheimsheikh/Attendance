import React, { useEffect, useState } from "react";
import { Loader2, Save, MapPin } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { getLocation } from "../../utils";
import SmsSenders from "./SmsSenders";
import VoiceMessages from "./VoiceMessages";

const TZS = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"];

export default function OfficeSettings() {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

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
        forenoon_start: form.forenoon_start || "09:30",
        forenoon_end: form.forenoon_end || "13:30",
        afternoon_start: form.afternoon_start || "13:30",
        afternoon_end: form.afternoon_end || "17:30",
      };
      const updated = await api.put("/office", body);
      setForm(updated);
      toast.success("Office settings saved");
    } catch (err) { toast.error(err?.message || "Failed"); }
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

        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-3" data-testid="of-half-day-block">
          <div>
            <p className="text-sm font-bold text-slate-800">Half-day session timings</p>
            <p className="text-[11px] text-slate-500">Used when a member applies for a half-day (forenoon / afternoon) leave or comp-off.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Forenoon start</label>
              <input data-testid="of-forenoon-start" type="time" value={form.forenoon_start || "09:30"} onChange={(e) => set("forenoon_start", e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Forenoon end</label>
              <input data-testid="of-forenoon-end" type="time" value={form.forenoon_end || "13:30"} onChange={(e) => set("forenoon_end", e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Afternoon start</label>
              <input data-testid="of-afternoon-start" type="time" value={form.afternoon_start || "13:30"} onChange={(e) => set("afternoon_start", e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Afternoon end</label>
              <input data-testid="of-afternoon-end" type="time" value={form.afternoon_end || "17:30"} onChange={(e) => set("afternoon_end", e.target.value)} className="iu-input" />
            </div>
          </div>
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

        <button data-testid="of-save" disabled={saving} className="iu-btn-primary w-full">
          {saving ? <Loader2 className="animate-spin" size={16}/> : <><Save size={16}/> Save settings</>}
        </button>
      </form>

      <SmsSenders />
      <VoiceMessages />
    </div>
  );
}
