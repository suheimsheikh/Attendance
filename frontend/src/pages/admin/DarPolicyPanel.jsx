import React, { useEffect, useState } from "react";
import { FileText, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

/** Office Settings card: DAR policy (on/off, effective date, min chars, WhatsApp group). */
export default function DarPolicyPanel() {
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/config/dar-policy").then(setCfg).catch((e) => toast.error(e?.message || "Failed to load DAR policy"));
  }, []);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      setCfg(await api.put("/config/dar-policy", {
        enabled: !!cfg.enabled, effective_from: cfg.effective_from,
        min_chars: Number(cfg.min_chars) || 20, group_name: cfg.group_name,
      }));
      toast.success("DAR policy saved");
    } catch (err) { toast.error(err?.message || "Save failed"); }
    finally { setSaving(false); }
  };
  if (!cfg) return <div className="iu-card p-6 mt-6"><Loader2 className="animate-spin text-slate-400 mx-auto" size={18} /></div>;
  return (
    <div className="iu-card p-4 sm:p-6 mt-6" data-testid="dar-policy-panel">
      <h2 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
        <FileText size={18} className="text-sky-600" /> Daily Activity Report (DAR)
      </h2>
      <p className="text-xs text-slate-500 mt-1 mb-4">
        Staff, Coaches and Executives must file a DAR before they can check out. Worked days with no DAR (from the
        effective date) count as missed and are reported to payroll. Mark individuals exempt in Manage Members.
      </p>
      <form onSubmit={save} className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} data-testid="dar-enabled" />
          DAR required at check-out
        </label>
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Effective from</span>
            <input type="date" value={cfg.effective_from || ""} onChange={(e) => setCfg({ ...cfg, effective_from: e.target.value })}
                   className="iu-input w-full !min-h-[44px] mt-1" data-testid="dar-effective-from" required />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-slate-700">Minimum characters</span>
            <input type="number" min="1" max="2000" value={cfg.min_chars} onChange={(e) => setCfg({ ...cfg, min_chars: e.target.value })}
                   className="iu-input w-full !min-h-[44px] mt-1" data-testid="dar-min-chars" />
          </label>
        </div>
        <label className="block">
          <span className="text-xs font-semibold text-slate-700">DAR WhatsApp group name</span>
          <input type="text" value={cfg.group_name || ""} onChange={(e) => setCfg({ ...cfg, group_name: e.target.value })}
                 className="iu-input w-full !min-h-[44px] mt-1" placeholder="e.g. YCH DAR" data-testid="dar-group-name" required />
          <span className="text-[11px] text-slate-400 mt-0.5 block">Shown in the share header so the member picks the right chat.</span>
        </label>
        <button type="submit" disabled={saving} className="iu-btn-primary w-full !min-h-[44px]" data-testid="dar-policy-save">
          {saving ? <Loader2 className="animate-spin" size={16} /> : <><Save size={16} /> Save DAR policy</>}
        </button>
      </form>
    </div>
  );
}
