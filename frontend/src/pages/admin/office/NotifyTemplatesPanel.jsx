import React, { useEffect, useState } from "react";
import { Loader2, Save, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";

/**
 * NotifyTemplatesPanel — editable bilingual WhatsApp messages sent to
 * parents from the Muster page (one-tap notify for Absent / Late). Distinct
 * from the Twilio SMS templates: these power the free wa.me deep-link
 * flow. Placeholders are filled per-athlete when the message opens.
 */
const NOTIFY_TPL_FIELDS = [
  { key: "absent_te", label: "Absent — Telugu", reason: "absent" },
  { key: "absent_en", label: "Absent — English", reason: "absent" },
  { key: "late_te",   label: "Late — Telugu", reason: "late" },
  { key: "late_en",   label: "Late — English", reason: "late" },
];

export function NotifyTemplatesPanel() {
  const [tpl, setTpl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/notify/templates")
      .then(setTpl)
      .catch((err) => toast.error(err?.message || "Failed to load notify templates"))
      .finally(() => setLoading(false));
  }, []);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.put("/notify/templates", tpl);
      setTpl(res);
      const mod = await import("../../../hooks/useNotifyTemplates");
      mod.clearNotifyTemplatesCache?.();
      toast.success("Parent notify templates saved");
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };
  if (loading || !tpl) {
    return (
      <div className="iu-card p-6 mt-6" data-testid="notify-templates-panel-loading">
        <Loader2 className="animate-spin text-slate-400 mx-auto" size={18} />
      </div>
    );
  }
  return (
    <div className="iu-card p-4 sm:p-6 mt-6" data-testid="notify-templates-panel">
      <div className="mb-4">
        <h2 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
          <Share2 size={18} className="text-emerald-600" /> WhatsApp Parent Messages
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          The bilingual messages pre-filled when you tap <b>Notify parent</b> on the Muster page
          (Absent / Late). Telugu and English are sent together. Leave a box blank to skip that language.
        </p>
        <p className="text-[11px] text-slate-500 mt-2">
          Placeholders (filled per-athlete): <code className="px-1 bg-slate-100 rounded">{"{name}"}</code>{" "}
          <code className="px-1 bg-slate-100 rounded">{"{academy}"}</code>{" "}
          <code className="px-1 bg-slate-100 rounded">{"{day}"}</code>{" "}
          <code className="px-1 bg-slate-100 rounded">{"{time}"}</code> (late){" "}
          <code className="px-1 bg-slate-100 rounded">{"{minutes}"}</code> (late)
        </p>
      </div>
      <form onSubmit={save} className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          {NOTIFY_TPL_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="iu-label flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${f.reason === "late" ? "bg-orange-500" : "bg-amber-500"}`} />
                {f.label}
              </label>
              <textarea
                data-testid={`notify-tpl-${f.key}`}
                value={tpl[f.key] || ""}
                onChange={(e) => setTpl({ ...tpl, [f.key]: e.target.value })}
                className="iu-input font-sans"
                rows={5}
              />
            </div>
          ))}
        </div>
        <button
          type="submit"
          disabled={saving}
          className="iu-btn-primary w-full !min-h-[44px]"
          data-testid="notify-tpl-save"
        >
          {saving ? <Loader2 className="animate-spin" size={16}/> : <><Save size={16}/> Save parent messages</>}
        </button>
      </form>
    </div>
  );
}
