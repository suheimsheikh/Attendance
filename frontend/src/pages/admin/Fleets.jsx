import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Edit3, Trash2, Sailboat, X, UserPlus, Users as UsersIcon, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useEscape } from "../../hooks/useEscape";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";

/**
 * Fleet master CRUD. Stores boat-classes (Optimist, ILCA 6, 420, etc.) so
 * every athlete's `fleet` field can be a dropdown sourced from this list
 * instead of free-text. The "Assign athletes" modal lets admins quickly
 * bulk-tag a roster.
 */
export default function Fleets() {
  const [fleets, setFleets] = useState([]);
  const [athletes, setAthletes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // {} = new, {...} = edit, null = closed
  const [assigning, setAssigning] = useState(null); // fleet name being assigned to

  const load = async () => {
    setLoading(true);
    try {
      // Resolve athlete-like category keys from the categories master so
      // both Athlete and Elite (and any future admin-added athlete-like
      // category) are pickable in the bulk-assign modal. Previously
      // filtered on `category === "athlete"` only, which hid Elite
      // squad members from the assign roster (bug fixed 04 Feb 2026).
      const [fl, cats, all] = await Promise.all([
        api.get("/fleets"),
        api.get("/masters/categories").catch(() => []),
        api.get("/members"),
      ]);
      const catRows = Array.isArray(cats) ? cats : (cats?.items || []);
      const athleteKeys = new Set(
        catRows.filter((c) => c.is_athlete_like).map((c) => c.key)
      );
      if (athleteKeys.size === 0) { athleteKeys.add("athlete"); athleteKeys.add("elite"); }
      const athl = (all || []).filter((m) => athleteKeys.has(m.category));
      setFleets(fl || []);
      setAthletes(athl);
    } catch (err) {
      toast.error(err?.message || "Failed to load fleets");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (f) => {
    if (!window.confirm(`Delete fleet "${f.name}"?\n\nAthletes already tagged with this fleet must be reassigned first.`)) return;
    try { await api.del(`/fleets/${f.id}`); toast.success("Fleet deleted"); load(); }
    catch (err) { toast.error(err?.message || "Delete failed"); }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8">
      <header className="flex items-end justify-between flex-wrap gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <Sailboat className="text-sky-600" size={28} /> Fleet Master
          </h1>
          <p className="text-sm text-slate-500 mt-1">Define boat classes once; assign athletes anytime. Renaming a fleet cascades to every athlete in it.</p>
        </div>
        <button onClick={() => setEditing({})} data-testid="fleet-new" className="iu-btn-primary">
          <Plus size={16} /> New fleet
        </button>
      </header>

      {loading ? (
        <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>
      ) : fleets.length === 0 ? (
        <div className="iu-card p-12 text-center text-slate-400">
          <Sailboat size={36} className="mx-auto mb-3 text-slate-300" />
          <p className="text-sm">No fleets yet. Tap <b>New fleet</b> to add Optimist, ILCA 6, 420, 29er…</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fleets.map((f) => (
            <div key={f.id} data-testid={`fleet-row-${f.id}`} className="iu-card p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center shrink-0">
                <Sailboat size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-extrabold text-slate-900 truncate flex items-center gap-2">
                  {f.name}
                  {f.short_name && <span className="text-[10px] font-bold px-1.5 rounded bg-slate-100 text-slate-600">{f.short_name}</span>}
                  {!f.active && <span className="text-[10px] font-bold px-1.5 rounded bg-amber-100 text-amber-800">Inactive</span>}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {f.athlete_count || 0} athlete{(f.athlete_count || 0) === 1 ? "" : "s"}
                  {f.notes && <span className="ml-2 italic">· {f.notes}</span>}
                </div>
              </div>
              <button onClick={() => setAssigning(f)} data-testid={`fleet-assign-${f.id}`} className="iu-btn-secondary !px-3 !h-9" title="Pick athletes for this fleet">
                <UserPlus size={14} />
              </button>
              <button onClick={() => setEditing(f)} data-testid={`fleet-edit-${f.id}`} className="iu-btn-secondary !px-3 !h-9">
                <Edit3 size={14} />
              </button>
              <button onClick={() => remove(f)} data-testid={`fleet-delete-${f.id}`} className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && <FleetForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {assigning && (
        <AssignAthletes
          fleet={assigning}
          athletes={athletes}
          onClose={() => setAssigning(null)}
          onSaved={() => { setAssigning(null); load(); }}
        />
      )}
    </div>
  );
}

function FleetForm({ initial, onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    name: initial?.name || "",
    short_name: initial?.short_name || "",
    notes: initial?.notes || "",
    active: initial?.active !== false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const formErr = useFormError();

  const submit = async (e) => {
    e.preventDefault();
    formErr.clear();
    if (!form.name.trim()) { formErr.setMessage("Name required"); return; }
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/fleets/${initial.id}`, form);
      else        await api.post("/fleets", form);
      toast.success(isEdit ? "Fleet updated" : "Fleet created");
      onSaved?.();
    } catch (err) { formErr.setFromApi(err, "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} data-testid="fleet-form" className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl p-6 space-y-4">
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">{isEdit ? "Edit fleet" : "New fleet"}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button>
        </header>
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="ff-name" value={form.name} onChange={(e) => set("name", e.target.value)} className="iu-input" placeholder="e.g. Optimist, ILCA 6, 420" autoFocus />
        </div>
        <div>
          <label className="iu-label">Short name (optional)</label>
          <input data-testid="ff-short" value={form.short_name} onChange={(e) => set("short_name", e.target.value)} className="iu-input" placeholder="OPT, ILCA6…" />
        </div>
        <div>
          <label className="iu-label">Notes (optional)</label>
          <textarea data-testid="ff-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} className="iu-input" placeholder="Anything coaches should know" />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" data-testid="ff-active" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          <span className="font-semibold">Active</span>
          <span className="text-slate-500 text-xs">(inactive fleets are hidden from dropdowns)</span>
        </label>
        <footer className="flex flex-col gap-2 pt-2 border-t border-slate-200">
          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="ff-save-error"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="iu-btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} data-testid="ff-save" className="iu-btn-primary">
              {saving ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>} Save
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function AssignAthletes({ fleet, athletes, onClose, onSaved }) {
  useEscape(onClose);
  const initialIds = useMemo(() => new Set(athletes.filter((a) => a.fleet === fleet.name).map((a) => a.id)), [athletes, fleet]);
  const [picked, setPicked] = useState(initialIds);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const formErr = useFormError();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return athletes.filter((a) =>
      !needle
      || (a.full_name || "").toLowerCase().includes(needle)
      || (a.fleet || "").toLowerCase().includes(needle)
      || (a.institution || "").toLowerCase().includes(needle)
    );
  }, [athletes, q]);

  const toggle = (id) => {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    // Diff against initial: athletes newly checked → assign to fleet;
    // athletes who were on this fleet and got UNchecked → clear.
    const toAssign = Array.from(picked).filter((id) => !initialIds.has(id));
    const toClear  = Array.from(initialIds).filter((id) => !picked.has(id));
    setSaving(true);
    formErr.clear();
    try {
      if (toAssign.length) await api.post("/fleets/assign", { fleet: fleet.name, member_ids: toAssign });
      if (toClear.length)  await api.post("/fleets/assign", { fleet: null,        member_ids: toClear  });
      toast.success(`Updated · +${toAssign.length} added, -${toClear.length} removed`);
      onSaved?.();
    } catch (err) { formErr.setFromApi(err, "Save failed"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} data-testid="fleet-assign-modal" className="bg-white w-full md:max-w-xl rounded-t-2xl md:rounded-2xl p-6 max-h-[92vh] flex flex-col">
        <header className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-xl font-extrabold flex items-center gap-2"><UsersIcon size={18}/> Assign athletes to {fleet.name}</h2>
            <p className="text-xs text-slate-500 mt-0.5">{picked.size} ticked · check / uncheck to move athletes in or out of this fleet.</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button>
        </header>

        <div className="relative mb-2">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            data-testid="assign-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search athletes by name, fleet, institution…"
            className="iu-input !pl-8 !text-sm"
          />
        </div>

        <div className="flex-1 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
          {filtered.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">No athletes match.</div>
          ) : (
            filtered.map((a) => {
              const on = picked.has(a.id);
              const currentFleet = a.fleet;
              const otherFleet = currentFleet && currentFleet !== fleet.name;
              return (
                <label key={a.id} className={`px-3 py-2 flex items-center gap-2 cursor-pointer ${on ? "bg-sky-50" : "hover:bg-slate-50"}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.id)} data-testid={`assign-${a.id}`} />
                  <span className="text-sm font-semibold flex-1 truncate">{a.full_name}</span>
                  {otherFleet && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold" title={`Currently in ${currentFleet} — ticking moves them to ${fleet.name}`}>
                      → {currentFleet}
                    </span>
                  )}
                  {a.institution && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{a.institution}</span>}
                </label>
              );
            })
          )}
        </div>

        <footer className="flex flex-col gap-2 pt-3 border-t border-slate-200 mt-3">
          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="assign-save-error"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose} className="iu-btn-secondary">Cancel</button>
            <button type="button" onClick={save} disabled={saving} data-testid="assign-save" className="iu-btn-primary">
              {saving ? <Loader2 className="animate-spin" size={16}/> : <Save size={16}/>} Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
