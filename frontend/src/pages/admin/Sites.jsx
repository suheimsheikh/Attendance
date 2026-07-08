import React, { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Edit3, MapPin, X, Crosshair, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";
import { useEscape } from "../../hooks/useEscape";

/**
 * Training Locations — additional geofenced spots where members train
 * (Rowing Academy, satellite dock, regatta venue, etc.). Added
 * 28 Jun 2026 to handle off-campus training sessions that should NOT
 * be flagged as "Off-site" in the activity feed. The main office/club
 * location is configured separately on the Office Settings page; this
 * list is additive — a check-in is on-site if it lands inside ANY
 * geofence (office OR any active training location).
 */
export default function Sites() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // {} = new, {...} = edit, null = closed

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/sites")); }
    catch (err) { toast.error(err?.message || "Failed to load training locations"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}"?\n\nExisting attendance rows tagged to this location will keep their stamped name.`)) return;
    try {
      await api.del(`/sites/${r.id}`);
      toast.success("Deleted");
      load();
    } catch (err) { toast.error(err?.message || "Delete failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <MapPin className="text-sky-600" size={28} /> Training Locations
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Additional geofenced spots where check-ins count as on-site
            (Rowing Academy, satellite dock, regatta venue, etc.).
            The main club location is set on <b>Office Settings</b>.
          </p>
        </div>
        <button onClick={() => setEditing({})} data-testid="site-new" className="iu-btn-primary">
          <Plus size={16} /> New location
        </button>
      </header>

      {loading ? (
        <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-12 text-center text-slate-400" data-testid="sites-empty">
          <MapPin size={36} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No additional training locations configured.</p>
          <p className="text-xs mt-2">Add the neighbouring Rowing Academy, satellite dock, regatta venue, or any spot where members regularly train.</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="sites-list">
          {rows.map((s) => (
            <div key={s.id} data-testid={`site-row-${s.id}`} className="iu-card p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                s.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
              }`}>
                <MapPin size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-semibold truncate">{s.name}</div>
                  {!s.active && (
                    <span className="text-[10px] uppercase tracking-wide bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded">Inactive</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5 tabular-nums">
                  {Number(s.latitude).toFixed(5)}, {Number(s.longitude).toFixed(5)} · {s.radius_m} m radius
                </div>
                {s.notes ? (
                  <div className="text-xs text-slate-400 mt-1 line-clamp-2">{s.notes}</div>
                ) : null}
              </div>
              <button
                onClick={() => setEditing(s)}
                data-testid={`site-edit-${s.id}`}
                className="iu-btn-ghost-sm" aria-label="Edit"
              ><Edit3 size={16} /></button>
              <button
                onClick={() => remove(s)}
                data-testid={`site-delete-${s.id}`}
                className="iu-btn-ghost-sm text-rose-600" aria-label="Delete"
              ><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <SiteForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function SiteForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name || "");
  const [lat, setLat] = useState(initial?.latitude ?? "");
  const [lng, setLng] = useState(initial?.longitude ?? "");
  const [radius, setRadius] = useState(initial?.radius_m ?? 150);
  const [active, setActive] = useState(initial?.active ?? true);
  const [notes, setNotes] = useState(initial?.notes || "");
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const { error, setMessage, clear } = useFormError();
  useEscape(onClose);

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setMessage("Your browser doesn't support geolocation");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
        setLocating(false);
        toast.success("Location captured");
      },
      (err) => {
        setLocating(false);
        setMessage(err?.message || "Could not get your location");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const save = async (e) => {
    e?.preventDefault?.();
    clear();
    const n = name.trim();
    if (!n) { setMessage("Name is required"); return; }
    const latN = Number(lat), lngN = Number(lng);
    if (Number.isNaN(latN) || Number.isNaN(lngN)) { setMessage("Latitude and longitude must be numbers"); return; }
    if (latN < -90 || latN > 90) { setMessage("Latitude out of range"); return; }
    if (lngN < -180 || lngN > 180) { setMessage("Longitude out of range"); return; }
    const radN = parseInt(radius, 10);
    if (!radN || radN <= 0 || radN >= 5000) { setMessage("Radius must be 1 – 4999 metres"); return; }

    const body = { name: n, latitude: latN, longitude: lngN, radius_m: radN, active, notes: notes.trim() || null };
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/sites/${initial.id}`, body);
      else await api.post(`/sites`, body);
      toast.success(isEdit ? "Location updated" : "Location created");
      onSaved();
    } catch (err) {
      setMessage(err?.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4" data-testid="site-form">
      <form onSubmit={save} className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-5 md:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <MapPin size={18} className="text-sky-600" />
            {isEdit ? "Edit training location" : "New training location"}
          </h2>
          <button type="button" onClick={onClose} className="iu-btn-ghost-sm" aria-label="Close" data-testid="site-form-close">
            <X size={18} />
          </button>
        </div>

        <FormErrorBanner error={error} onDismiss={clear} />

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Name</span>
            <input
              data-testid="site-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rowing Academy"
              className="iu-input mt-1"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Latitude</span>
              <input
                data-testid="site-lat"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                placeholder="17.40000"
                inputMode="decimal"
                className="iu-input mt-1 tabular-nums"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Longitude</span>
              <input
                data-testid="site-lng"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                placeholder="78.50000"
                inputMode="decimal"
                className="iu-input mt-1 tabular-nums"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            data-testid="site-use-location"
            className="text-xs text-sky-700 hover:text-sky-900 flex items-center gap-1 disabled:opacity-50"
          >
            {locating ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
            {locating ? "Locating…" : "Use my current location"}
          </button>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Radius (metres)</span>
            <input
              data-testid="site-radius"
              type="number"
              min="1"
              max="4999"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="iu-input mt-1 tabular-nums"
            />
            <span className="text-[11px] text-slate-400 mt-0.5 block">
              Members checking in within this many metres are considered on-site.
            </span>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-slate-600">Notes (optional)</span>
            <textarea
              data-testid="site-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What happens here? When is it active?"
              className="iu-input mt-1 resize-none"
            />
          </label>

          <label className="flex items-center gap-2 mt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              data-testid="site-active"
              className="w-4 h-4 accent-sky-600"
            />
            <span className="text-sm">Active — count check-ins here as on-site</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} className="iu-btn-secondary" data-testid="site-form-cancel">Cancel</button>
          <button type="submit" disabled={saving} className="iu-btn-primary" data-testid="site-form-save">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {isEdit ? "Save changes" : "Create location"}
          </button>
        </div>
      </form>
    </div>
  );
}
