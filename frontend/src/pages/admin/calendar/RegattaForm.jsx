import React, { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";
import { useDirtyForm } from "../../../hooks/useDirtyForm";
import TopSaveButton from "../../../components/TopSaveButton";
import { useFormError } from "../../../hooks/useFormError";
import FormErrorBanner from "../../../components/FormErrorBanner";
import { LEVEL_STYLE, LEVELS, ymd } from "./helpers";

/**
 * RegattaForm — modal for creating or editing a regatta (event for which
 * athletes apply for leave). Extracted from Calendar.jsx — all state local.
 */
export default function RegattaForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const today = ymd(new Date());
  const [form, setForm] = useState({
    name:        initial?.name || "",
    level:       initial?.level || "national",
    location:    initial?.location || "",
    country:     initial?.country || "",
    start_date:  initial?.start_date || today,
    end_date:    initial?.end_date || today,
    host_org:    initial?.host_org || "",
    notes:       initial?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const guard = useDirtyForm(form, onClose);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const formErr = useFormError();

  const submit = async (e) => {
    e?.preventDefault?.();
    formErr.clear();
    if (!form.name.trim()) { formErr.setMessage("Name is required"); return; }
    if (form.start_date > form.end_date) { formErr.setMessage("Start must be on or before end"); return; }
    const payload = { ...form };
    Object.keys(payload).forEach((k) => { if (payload[k] === "") delete payload[k]; });
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/regattas/${initial.id}`, payload);
      else        await api.post("/regattas", payload);
      toast.success(isEdit ? "Updated" : "Created");
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
        data-testid="regatta-form"
        className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <h2 className="text-xl font-extrabold">{isEdit ? "Edit regatta" : "New regatta"}</h2>
          <TopSaveButton formId="regatta-form-el" dirty={guard.dirty} saving={saving} testId="rf-top-save" />
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="rf-name" value={form.name} onChange={(e) => set("name", e.target.value)} className="iu-input" placeholder="e.g. 49er World Championship 2026" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Level</label>
            <select data-testid="rf-level" value={form.level} onChange={(e) => set("level", e.target.value)} className="iu-input">
              {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_STYLE[l].label}</option>)}
            </select>
          </div>
          <div>
            <label className="iu-label">Host org (optional)</label>
            <input data-testid="rf-host" value={form.host_org} onChange={(e) => set("host_org", e.target.value)} className="iu-input" placeholder="World Sailing, YAI…" />
          </div>
          <div>
            <label className="iu-label">Location</label>
            <input data-testid="rf-location" value={form.location} onChange={(e) => set("location", e.target.value)} className="iu-input" placeholder="Auckland" />
          </div>
          <div>
            <label className="iu-label">Country</label>
            <input data-testid="rf-country" value={form.country} onChange={(e) => set("country", e.target.value)} className="iu-input" placeholder="New Zealand" />
          </div>
          <div>
            <label className="iu-label">Start date</label>
            <input data-testid="rf-start" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">End date</label>
            <input data-testid="rf-end" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="iu-input" />
          </div>
        </div>
        <div>
          <label className="iu-label">Notes (optional)</label>
          <textarea data-testid="rf-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} className="iu-input" placeholder="Travel info, points of contact…" />
        </div>
        <footer className="flex flex-col gap-2 pt-2 border-t border-slate-200">
          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="rf-save-error"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={guard.close} className="iu-btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} data-testid="rf-save" className="iu-btn-primary">
              {saving ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save" : "Create")}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
