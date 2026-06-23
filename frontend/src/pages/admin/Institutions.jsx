import React, { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Edit3, Building2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

export default function Institutions() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/institutions")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}"?`)) return;
    try {
      await api.del(`/institutions/${r.id}`);
      toast.success("Deleted");
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Institutions</h1>
          <p className="text-slate-500 text-sm mt-1">Master list — appears in member onboarding dropdown.</p>
        </div>
        <button onClick={() => setEditing({})} className="iu-btn-primary" data-testid="new-institution"><Plus size={16}/> Add institution</button>
      </header>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center">
          <Building2 size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="font-semibold">No institutions yet</p>
          <p className="text-sm text-slate-500 mt-1">Add your first one to get the dropdown working in member forms.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="iu-card p-3 flex items-center gap-3 flex-wrap" data-testid={`inst-row-${r.id}`}>
              <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center"><Building2 size={16}/></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{r.name}</div>
                <div className="text-xs text-slate-500">{r.short_name ? `${r.short_name} · ` : ""}{r.member_count} member{r.member_count === 1 ? "" : "s"}</div>
                {/* Institution-level Twilio chips are temporarily hidden —
                    the app uses the Office default-from-number for every
                    notification. Re-enable by removing the `false &&` below
                    when per-institution sender numbers are needed again. */}
                {false && (r.sms_from_number || r.voice_from_number) && (
                  <div className="text-[11px] text-emerald-700 font-mono mt-0.5 truncate">
                    {r.sms_from_number ? `SMS ${r.sms_from_number}` : ""}
                    {r.sms_from_number && r.voice_from_number ? "  ·  " : ""}
                    {r.voice_from_number ? `Voice ${r.voice_from_number}` : ""}
                  </div>
                )}
              </div>
              {!r.active && <span className="text-[10px] uppercase font-bold text-slate-400 mr-2">Inactive</span>}
              <button onClick={() => setEditing(r)} className="p-2 rounded-lg hover:bg-slate-100" data-testid={`inst-edit-${r.id}`}><Edit3 size={16}/></button>
              <button onClick={() => remove(r)} className="p-2 rounded-lg hover:bg-red-50 text-red-600" data-testid={`inst-delete-${r.id}`}><Trash2 size={16}/></button>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <InstForm
          initial={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function InstForm({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [shortName, setShortName] = useState(initial?.short_name || "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [smsFrom, setSmsFrom] = useState(initial?.sms_from_number || "");
  const [voiceFrom, setVoiceFrom] = useState(initial?.voice_from_number || "");
  const [busy, setBusy] = useState(false);
  const isEdit = !!initial;

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name required"); return; }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        short_name: shortName.trim(),
        active,
        sms_from_number: smsFrom.trim(),
        voice_from_number: voiceFrom.trim(),
      };
      if (isEdit) {
        await api.patch(`/institutions/${initial.id}`, payload);
      } else {
        await api.post("/institutions", payload);
      }
      toast.success("Saved");
      onSaved();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <h3 className="font-extrabold text-lg">{isEdit ? "Edit" : "Add"} institution</h3>
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="inst-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="iu-input" />
        </div>
        <div>
          <label className="iu-label">Short name <span className="text-slate-400 font-normal normal-case">(optional)</span></label>
          <input data-testid="inst-short" value={shortName} onChange={(e) => setShortName(e.target.value)} className="iu-input" placeholder="e.g. IIT, KIIT" />
        </div>
        {/* Per-institution Twilio sender numbers — disabled for now. The
            app uses the Office Settings default-from-number for every parent
            notification. The fields are intentionally retained (and the
            backend resolution still falls through correctly) so we can
            re-enable per-institution sender branding later without losing
            the wiring. */}
        <div className="pt-2 border-t border-slate-200">
          <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">
            Twilio sender numbers <span className="text-amber-700 font-normal normal-case ml-1">(disabled — using Office default)</span>
          </p>
          <div>
            <label className="iu-label text-slate-400">SMS &quot;from&quot; number</label>
            <input
              data-testid="inst-sms-from"
              value={smsFrom}
              onChange={(e) => setSmsFrom(e.target.value)}
              disabled
              className="iu-input font-mono text-xs bg-slate-100 text-slate-400 cursor-not-allowed"
              placeholder="Disabled — Office default-from used for all SMS"
              title="Per-institution sender numbers are disabled. The app uses the Office Settings default-from-number for every parent notification."
            />
          </div>
          <div className="mt-2">
            <label className="iu-label text-slate-400">Voice &quot;from&quot; number</label>
            <input
              data-testid="inst-voice-from"
              value={voiceFrom}
              onChange={(e) => setVoiceFrom(e.target.value)}
              disabled
              className="iu-input font-mono text-xs bg-slate-100 text-slate-400 cursor-not-allowed"
              placeholder="Disabled — Office default-from used for all voice calls"
              title="Per-institution sender numbers are disabled. The app uses the Office Settings default-from-number for every voice call."
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer pt-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (show in onboarding dropdown)
        </label>
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="iu-btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={busy} className="iu-btn-primary flex-1">{busy ? <Loader2 className="animate-spin" size={14}/> : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
