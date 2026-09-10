import React, { useEffect, useState } from "react";
import { ScrollText, CheckCircle2, Loader2, ShieldCheck, Pencil, Plus, Trash2, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useAuth } from "../auth";

const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

export default function Rules() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accs, setAccs] = useState(null);
  const [editing, setEditing] = useState(false);

  const loadAccs = () => { if (user?.role === "admin") api.get("/admin/rules/acceptances").then(setAccs).catch(() => {}); };
  const load = () => api.get("/rules").then(setData).catch((e) => toast.error(e?.message || "Couldn't load rules"));
  useEffect(() => { load(); }, []);
  useEffect(() => { loadAccs(); }, [user?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = async () => {
    setBusy(true);
    try {
      await api.post("/rules/accept");
      toast.success("Thank you — rules accepted");
      await load();
      window.dispatchEvent(new Event("rules-accepted"));
    } catch (e) { toast.error(e?.message || "Couldn't record acceptance"); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="p-8 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>;

  if (editing) {
    return <RulesEditor data={data} onCancel={() => setEditing(false)}
      onSaved={async () => { setEditing(false); await load(); loadAccs(); }} />;
  }

  let n = 0;
  const mustAccept = data.required && !data.accepted;
  const isAdmin = user?.role === "admin";

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="rules-page">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2"><ScrollText size={24} className="text-sky-600" /> Attendance Rules</h1>
          <p className="text-slate-500 text-sm mt-1">Yacht Club of Hyderabad — version {data.version}. Applies to Staff, Coaches and Executives; recorded and enforced through this app.</p>
        </div>
        {isAdmin && (
          <button onClick={() => setEditing(true)} className="iu-btn-secondary shrink-0" data-testid="rules-edit">
            <Pencil size={15} /> Edit rules
          </button>
        )}
      </header>

      {mustAccept && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 mb-6 text-sm text-amber-900 font-semibold" data-testid="rules-must-accept">
          Please read the rules below and accept them to continue using the app.
        </div>
      )}
      {data.accepted && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 mb-6 text-sm text-emerald-800 flex items-center gap-2" data-testid="rules-accepted-banner">
          <CheckCircle2 size={16} /> You accepted version {data.accepted.version} on {fmt(data.accepted.accepted_at)}.
        </div>
      )}

      <div className="iu-card p-5 md:p-7 space-y-6">
        {data.sections.map((s) => (
          <section key={s.heading}>
            <h2 className="text-base md:text-lg font-extrabold tracking-tight text-slate-900 mb-2">{s.heading}</h2>
            <ol className="space-y-2">
              {s.rules.map((r) => { n += 1; return (
                <li key={n} className="flex gap-3 text-sm text-slate-700 leading-relaxed" data-testid={`rule-${n}`}>
                  <span className="shrink-0 w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">{n}</span>
                  <span className="pt-1">{r}</span>
                </li>
              ); })}
            </ol>
          </section>
        ))}
      </div>

      {mustAccept && (
        <div className="iu-card p-5 mt-6" data-testid="rules-accept-card">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 h-4 w-4" data-testid="rules-agree" />
            <span className="text-sm text-slate-800">I, <b>{user?.full_name}</b>, have read and understood the Attendance Rules above and agree to abide by them.</span>
          </label>
          <button onClick={accept} disabled={!agree || busy} className="iu-btn-primary w-full mt-4" data-testid="rules-accept">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Accept the rules
          </button>
        </div>
      )}

      {accs && (
        <section className="iu-card p-5 mt-6" data-testid="rules-acceptances">
          <h3 className="font-extrabold tracking-tight text-sm text-slate-500 uppercase mb-2">Sign-off status · v{accs.version} · {accs.accepted} accepted · {accs.pending} pending</h3>
          <ul className="divide-y divide-slate-100 text-sm">
            {accs.rows.map((r) => (
              <li key={r.member_id} className="py-1.5 flex items-center gap-2" data-testid={`rules-acc-${r.member_id}`}>
                <span className="flex-1 truncate">{r.member_name} <span className="text-[10px] uppercase text-slate-400">{r.category}</span></span>
                {r.accepted_at ? <span className="text-emerald-700 text-xs font-semibold">{fmt(r.accepted_at)}</span> : <span className="text-rose-600 text-xs font-semibold">pending</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Admin-only inline editor. Edit each section's heading and its rules (one
 * per line), add / remove sections, and bump the version. Saving with a
 * NEW version resets everyone's sign-off so the whole team must re-accept.
 */
function RulesEditor({ data, onCancel, onSaved }) {
  const [version, setVersion] = useState(data.version || "");
  const [sections, setSections] = useState(
    (data.sections || []).map((s) => ({ heading: s.heading, body: (s.rules || []).join("\n") }))
  );
  const [saving, setSaving] = useState(false);
  const versionBumped = version.trim() && version.trim() !== data.version;
  const initialSnap = React.useRef(JSON.stringify({ version, sections }));
  const dirty = JSON.stringify({ version, sections }) !== initialSnap.current;
  const cancel = () => { if (dirty && !window.confirm("You have unsaved rule edits. Discard them?")) return; onCancel(); };

  const setSec = (i, k, v) => setSections((arr) => arr.map((s, idx) => idx === i ? { ...s, [k]: v } : s));
  const addSec = () => setSections((arr) => [...arr, { heading: "", body: "" }]);
  const removeSec = (i) => setSections((arr) => arr.filter((_, idx) => idx !== i));

  const save = async () => {
    const parsed = sections.map((s) => ({
      heading: (s.heading || "").trim(),
      rules: s.body.split("\n").map((r) => r.trim()).filter(Boolean),
    }));
    const orphanHeading = parsed.find((s) => s.heading && !s.rules.length);
    if (orphanHeading) { toast.error(`Section "${orphanHeading.heading}" has no rules — add at least one line or remove the section`); return; }
    const payload = parsed.filter((s) => s.rules.length);
    if (!payload.length) { toast.error("Add at least one rule before saving"); return; }
    if (payload.some((s) => !s.heading)) { toast.error("Every section needs a heading"); return; }
    const contentChanged = JSON.stringify(payload) !== JSON.stringify(data.sections || []);
    if (contentChanged && !versionBumped) {
      toast.error("You changed the rule text — set a new version (e.g. bump the number) so the team re-signs the updated rules.");
      return;
    }
    if (versionBumped && !window.confirm(`Bump to version "${version.trim()}"?\n\nEveryone who signed the previous version will be asked to read and re-accept the rules.`)) return;
    setSaving(true);
    try {
      await api.put("/admin/rules", { version: version.trim() || undefined, sections: payload });
      toast.success(versionBumped ? "Rules saved — team will be asked to re-sign" : "Rules saved");
      onSaved();
    } catch (e) { toast.error(e?.message || "Couldn't save rules"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="rules-editor">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2"><Pencil size={22} className="text-sky-600" /> Edit Attendance Rules</h1>
          <p className="text-slate-500 text-sm mt-1">One rule per line. Reorder within a section by editing the lines.</p>
        </div>
        <button onClick={cancel} className="text-slate-400 hover:text-slate-700" title="Cancel" data-testid="rules-editor-cancel"><X size={20} /></button>
      </header>

      <div className="iu-card p-4 mb-4">
        <label className="iu-label">Version</label>
        <input value={version} onChange={(e) => setVersion(e.target.value)} className="iu-input max-w-xs" placeholder="e.g. 2026-10" data-testid="rules-version-input" />
        {versionBumped && (
          <p className="text-[13px] text-amber-700 font-semibold mt-2 flex items-center gap-1.5" data-testid="rules-version-warning">
            <AlertTriangle size={14} /> Version changed — everyone will be asked to re-sign after you save.
          </p>
        )}
      </div>

      <div className="space-y-3">
        {sections.map((s, i) => (
          <div key={i} className="iu-card p-4" data-testid={`rules-section-${i}`}>
            <div className="flex items-center gap-2 mb-2">
              <input value={s.heading} onChange={(e) => setSec(i, "heading", e.target.value)} className="iu-input font-bold" placeholder="Section heading" data-testid={`rules-section-heading-${i}`} />
              <button onClick={() => removeSec(i)} className="p-2 rounded-lg text-rose-500 hover:bg-rose-50 shrink-0" title="Remove section" data-testid={`rules-section-remove-${i}`}><Trash2 size={16} /></button>
            </div>
            <textarea value={s.body} onChange={(e) => setSec(i, "body", e.target.value)} rows={Math.max(3, s.body.split("\n").length)} className="iu-input font-mono text-sm leading-relaxed" placeholder="One rule per line…" data-testid={`rules-section-body-${i}`} />
          </div>
        ))}
      </div>

      <button onClick={addSec} className="iu-btn-secondary mt-3" data-testid="rules-add-section"><Plus size={15} /> Add section</button>

      <div className="flex gap-2 justify-end mt-6 pt-4 border-t border-slate-200">
        <button onClick={cancel} className="iu-btn-secondary" data-testid="rules-editor-cancel-btn">Cancel</button>
        <button onClick={save} disabled={saving} className="iu-btn-primary" data-testid="rules-editor-save">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Save rules
        </button>
      </div>
    </div>
  );
}
