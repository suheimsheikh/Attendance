import React, { useEffect, useState } from "react";
import { Plane, Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";
import TeamPicker from "../calendar/TeamPicker";

const ISSUE = {
  missing: ["No passport on file", "bg-rose-100 text-rose-700"],
  no_expiry: ["Expiry date not entered", "bg-amber-100 text-amber-800"],
  expiring: ["Not valid 6 months after the regatta", "bg-rose-100 text-rose-700"],
};

// Overseas (non-India) regattas → athletes & coaches whose passport won't do.
export default function TravelCheck() {
  const [data, setData] = useState(null);
  const [regattaId, setRegattaId] = useState("");
  const [showOk, setShowOk] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api.get("/id-docs/travel-check", regattaId ? { regatta_id: regattaId } : undefined)
      .then(setData).catch((e) => showApiError(e, "Couldn't load travel check"));
  }, [regattaId, reload]);

  if (!data) return <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>;
  if (!data.regatta) return <div className="iu-card p-8 text-center text-slate-500" data-testid="travel-none">No upcoming regattas outside India.</div>;
  const rows = data.rows.filter((r) => showOk || r.issue);
  return (
    <div data-testid="travel-check">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Plane className="text-sky-600" size={18} />
        <select value={data.regatta.id} onChange={(e) => setRegattaId(e.target.value)} className="iu-input !w-auto" data-testid="travel-regatta"
          title="Upcoming regattas outside India">
          {data.regattas.map((r) => <option key={r.id} value={r.id}>{`${r.name} · ${r.country} · ${r.start_date}`}</option>)}
        </select>
        <span className="text-xs text-slate-600" data-testid="travel-needed" title="Most countries need 6 months' validity after you leave">
          Passport must be valid until <b>{data.valid_until_needed}</b>
        </span>
        <button type="button" onClick={() => setEditing(true)} className="iu-btn-secondary !py-1 !px-3 text-xs inline-flex items-center gap-1"
          data-testid="travel-edit-team" title="Choose who is going to this regatta">
          <Users size={14} /> Edit team{data.team_picked ? ` (${data.regatta.team_ids.length})` : ""}
        </button>
        <label className="text-xs flex items-center gap-1.5 ml-auto" title="Also list people whose passport is fine">
          <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} data-testid="travel-show-ok" /> Show valid too
        </label>
      </div>
      {!data.team_picked && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-xs px-3 py-2" data-testid="travel-no-team">
          No team picked yet — showing everyone (all athletes &amp; coaches).
        </div>
      )}
      <div className="iu-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr><th className="p-2 text-left">Member</th><th className="p-2 text-left">Category</th><th className="p-2 text-left">Passport</th>
              <th className="p-2 text-left">Expiry</th><th className="p-2 text-left">Problem</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.member_id} className="border-t border-slate-100" data-testid={`travel-row-${r.member_id}`}>
                <td className="p-2 font-semibold">{r.member_name}</td>
                <td className="p-2 text-xs text-slate-600">{r.category}</td>
                <td className="p-2 font-mono text-xs">{r.passport || "—"}</td>
                <td className="p-2 text-xs">{r.passport_expiry || "—"}</td>
                <td className="p-2">{r.issue
                  ? <span className={`px-1.5 rounded text-xs font-semibold ${ISSUE[r.issue][1]}`} data-testid={`travel-issue-${r.member_id}`}>{ISSUE[r.issue][0]}</span>
                  : <span className="text-emerald-700 text-xs font-semibold">OK</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="p-8 text-center text-slate-400">Everyone&apos;s passport is fine for this regatta.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <TeamModal regatta={data.regatta} onClose={() => setEditing(false)}
        onSaved={() => { setEditing(false); setReload((n) => n + 1); }} />}
    </div>
  );
}

function TeamModal({ regatta, onClose, onSaved }) {
  const [ids, setIds] = useState(regatta.team_ids || []);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/regattas/${regatta.id}`, { team_ids: ids });
      toast.success("Team saved");
      onSaved();
    } catch (e) { showApiError(e, "Couldn't save team"); } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-6 space-y-4" data-testid="travel-team-modal">
        <h2 className="text-lg font-extrabold">Team · {regatta.name}</h2>
        <TeamPicker value={ids} onChange={setIds} />
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="iu-btn-secondary" data-testid="travel-team-cancel">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="iu-btn-primary" data-testid="travel-team-save">
            {saving ? <Loader2 className="animate-spin" size={16} /> : "Save team"}
          </button>
        </div>
      </div>
    </div>
  );
}
