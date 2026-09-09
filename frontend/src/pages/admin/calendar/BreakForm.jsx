import React, { useMemo, useState } from "react";
import { Loader2, Coffee } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";
import { useDirtyForm } from "../../../hooks/useDirtyForm";
import TopSaveButton from "../../../components/TopSaveButton";
import { useFormError } from "../../../hooks/useFormError";
import FormErrorBanner from "../../../components/FormErrorBanner";
import { SCOPES, ymd } from "./helpers";

/**
 * BreakForm — modal for marking a holiday / rest day / fleet pause.
 * Extracted from Calendar.jsx. Re-exported from Calendar.jsx via a barrel
 * so existing `import { BreakForm } from "./Calendar"` callers keep working.
 *
 * Scope picker drives an adaptive sub-form (institution dropdown / fleet
 * dropdown / per-member checkbox list). Athlete-only on the per-member
 * list because breaks are an athlete concept (coach/staff time-off goes
 * through the Leaves flow).
 */
export default function BreakForm({ initial, members, institutions, fleets, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const today = ymd(new Date());
  const [form, setForm] = useState({
    name:        initial?.name || "",
    scope:       initial?.scope || "all",
    start_date:  initial?.start_date || today,
    end_date:    initial?.end_date || today,
    institution: initial?.institution || "",
    fleet:       initial?.fleet || "",
    member_ids:  initial?.member_ids || [],
    notes:       initial?.notes || "",
  });
  const [memberSearch, setMemberSearch] = useState("");
  // Optional fleet filter applied to the per-member checkbox list when
  // scope=selected. Lets admins quickly tick e.g. all Laser athletes without
  // needing to switch to scope=fleet.
  const [memberFleetFilter, setMemberFleetFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const guard = useDirtyForm(form, onClose);
  const formErr = useFormError();
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleMember = (id) => set("member_ids",
    form.member_ids.includes(id)
      ? form.member_ids.filter((x) => x !== id)
      : [...form.member_ids, id]
  );

  // Distinct fleet values — prefer the fleet master (if passed in by the
  // caller), otherwise fall back to scanning ATHLETES for fleet labels.
  const fleetOptions = useMemo(() => {
    if (fleets && fleets.length) return fleets.map((f) => f.name);
    const seen = new Set();
    for (const m of members || []) {
      if ((m.category || "athlete") !== "athlete") continue;
      if (m.fleet) seen.add(m.fleet);
    }
    return Array.from(seen).sort();
  }, [fleets, members]);

  const athleteMembers = useMemo(
    () => (members || []).filter((m) => (m.category || "athlete") === "athlete"),
    [members]
  );
  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return athleteMembers.filter((m) => {
      if (memberFleetFilter && (m.fleet || "") !== memberFleetFilter) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q)
          || (m.fleet || "").toLowerCase().includes(q);
    });
  }, [athleteMembers, memberSearch, memberFleetFilter]);

  const submit = async (e) => {
    e?.preventDefault?.();
    formErr.clear();
    if (!form.name.trim()) { formErr.setMessage("Name is required"); return; }
    if (form.start_date > form.end_date) { formErr.setMessage("Start must be on or before end"); return; }
    if (form.scope === "institution" && !form.institution) { formErr.setMessage("Pick an institution"); return; }
    if (form.scope === "fleet" && !form.fleet) { formErr.setMessage("Pick a fleet"); return; }
    if (form.scope === "selected" && form.member_ids.length === 0) { formErr.setMessage("Pick at least one member"); return; }
    const payload = { ...form };
    if (payload.scope !== "institution") delete payload.institution;
    if (payload.scope !== "fleet") delete payload.fleet;
    if (payload.scope !== "selected") payload.member_ids = [];
    if (!payload.notes) delete payload.notes;
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/breaks/${initial.id}`, payload);
      else        await api.post("/breaks", payload);
      toast.success(isEdit ? "Break updated" : "Break applied");
      onSaved?.();
    } catch (err) {
      formErr.setFromApi(err, "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={guard.close}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="break-form"
        className="bg-white w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold flex items-center gap-2">
            <Coffee size={18} className="text-amber-600" /> {isEdit ? "Edit break" : "Apply break"}
          </h2>
          <TopSaveButton formId="break-form-el" dirty={guard.dirty} saving={saving} testId="bf-top-save" />
          <button type="button" onClick={guard.close} className="text-slate-400 hover:text-slate-700 text-sm">Close</button>
        </header>

        <div>
          <label className="iu-label">What is this break?</label>
          <input
            data-testid="bf-name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            className="iu-input"
            placeholder="e.g. Diwali holiday, MJPT rest week, Coaches off-day"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">From</label>
            <input data-testid="bf-start" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">To</label>
            <input data-testid="bf-end" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="iu-input" />
          </div>
        </div>

        <div>
          <label className="iu-label">Who is on break?</label>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {SCOPES.map((s) => {
              const on = form.scope === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  data-testid={`bf-scope-${s.key}`}
                  onClick={() => set("scope", s.key)}
                  className={`text-left px-3 py-2 rounded-lg border transition ${on ? "border-amber-400 bg-amber-50 ring-1 ring-amber-300" : "border-slate-200 hover:bg-slate-50"}`}
                >
                  <div className={`font-semibold text-sm ${on ? "text-amber-800" : "text-slate-800"}`}>{s.label}</div>
                  <div className="text-[11px] text-slate-500 mt-0.5">{s.hint}</div>
                </button>
              );
            })}
          </div>
        </div>

        {form.scope === "institution" && (
          <div>
            <label className="iu-label">Institution</label>
            <select
              data-testid="bf-institution"
              value={form.institution}
              onChange={(e) => set("institution", e.target.value)}
              className="iu-input"
            >
              <option value="">— Pick one —</option>
              {institutions.map((i) => (
                <option key={i.id || i.name} value={i.name}>{i.name}</option>
              ))}
            </select>
          </div>
        )}

        {form.scope === "fleet" && (
          <div>
            <label className="iu-label">Fleet</label>
            {fleetOptions.length === 0 ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
                No athletes have a fleet set yet. Edit some athletes from Manage Members and add a fleet (e.g. Optimist, ILCA 6), then try again.
              </p>
            ) : (
              <select
                data-testid="bf-fleet"
                value={form.fleet}
                onChange={(e) => set("fleet", e.target.value)}
                className="iu-input"
              >
                <option value="">— Pick one —</option>
                {fleetOptions.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
          </div>
        )}

        {form.scope === "selected" && (
          <div>
            <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
              <label className="iu-label !m-0">Athletes on break ({form.member_ids.length})</label>
              <input
                data-testid="bf-member-search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search athletes by name…"
                className="iu-input !h-8 !text-xs !py-1 !w-44"
              />
            </div>
            {fleetOptions.length > 0 && (
              <div className="flex items-center gap-1 mb-1.5 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1">Filter</span>
                <button
                  type="button"
                  data-testid="bf-fleet-filter-all"
                  onClick={() => setMemberFleetFilter("")}
                  className={`px-2 h-6 rounded-full text-[10px] font-bold transition border ${
                    memberFleetFilter === "" ? "bg-amber-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  All fleets
                </button>
                {fleetOptions.map((f) => (
                  <button
                    key={f}
                    type="button"
                    data-testid={`bf-fleet-filter-${f}`}
                    onClick={() => setMemberFleetFilter(f)}
                    className={`px-2 h-6 rounded-full text-[10px] font-bold transition border ${
                      memberFleetFilter === f ? "bg-amber-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {f}
                  </button>
                ))}
                {memberFleetFilter && (
                  <button
                    type="button"
                    data-testid="bf-select-all-filtered"
                    onClick={() => {
                      const ids = filteredMembers.map((m) => m.id);
                      const merged = Array.from(new Set([...form.member_ids, ...ids]));
                      set("member_ids", merged);
                    }}
                    className="ml-1 px-2 h-6 rounded-full text-[10px] font-bold border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100"
                    title="Tick everyone in this fleet"
                  >
                    + Add all {filteredMembers.length}
                  </button>
                )}
              </div>
            )}
            <div className="border border-slate-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-slate-100">
              {filteredMembers.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-400">No athletes match.</div>
              ) : (
                filteredMembers.map((m) => {
                  const on = form.member_ids.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      className={`px-3 py-2 flex items-center gap-2 cursor-pointer ${on ? "bg-amber-50" : "hover:bg-slate-50"}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleMember(m.id)}
                        data-testid={`bf-member-${m.id}`}
                      />
                      <span className="text-sm font-medium flex-1 truncate">{m.full_name}</span>
                      {m.institution && <span className="text-[10px] px-1.5 rounded bg-slate-100 text-slate-600">{m.institution}</span>}
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        <div>
          <label className="iu-label">Notes (optional)</label>
          <textarea
            data-testid="bf-notes"
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            className="iu-input"
            placeholder="Context, reason, source…"
          />
        </div>

        <footer className="flex flex-col gap-2 pt-2 border-t border-slate-200">
          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="bf-save-error"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={guard.close} className="iu-btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} data-testid="bf-save" className="iu-btn-primary !bg-amber-600 hover:!bg-amber-700">
              {saving ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save changes" : "Apply break")}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
