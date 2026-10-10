import React, { useEffect, useState } from "react";
import { Loader2, Save, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";

/**
 * WhatsappGroupsPanel — two named groups used by every "Share to
 * WhatsApp" button across the app. Muster / Escort / Meals-related
 * shares auto-select the **athletes** group; admin summary shares
 * pick the **staff** group. Defaults ship in from the backend so a
 * fresh install works out of the box.
 */
export function WhatsappGroupsPanel() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/config/whatsapp-groups")
      .then(setCfg)
      .catch((err) => toast.error(err?.message || "Failed to load WhatsApp groups"))
      .finally(() => setLoading(false));
  }, []);
  const save = async (e) => {
    e.preventDefault();
    if (!cfg?.staff_group_name?.trim() || !cfg?.athletes_group_name?.trim()) {
      toast.error("Both group names are required.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.put("/config/whatsapp-groups", {
        staff_group_name: cfg.staff_group_name.trim(),
        athletes_group_name: cfg.athletes_group_name.trim(),
        tuitions_group_name: (cfg.tuitions_group_name || "").trim(),
      });
      setCfg(res);
      // Invalidate the in-memory cache used by useWhatsappGroups so the
      // next share picks up the new names immediately.
      const mod = await import("../../../hooks/useWhatsappGroups");
      mod.clearWhatsappGroupsCache?.();
      toast.success("WhatsApp groups saved");
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };
  if (loading || !cfg) {
    return (
      <div className="iu-card p-6 mt-6" data-testid="whatsapp-groups-panel-loading">
        <Loader2 className="animate-spin text-slate-400 mx-auto" size={18} />
      </div>
    );
  }
  return (
    <div className="iu-card p-4 sm:p-6 mt-6" data-testid="whatsapp-groups-panel">
      <div className="mb-4">
        <h2 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
          <Share2 size={18} className="text-emerald-600" /> WhatsApp Groups
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Names of the two WhatsApp groups used across every &ldquo;Share to WhatsApp&rdquo; button.
          Muster / Escort / Meals shares auto-target the <b>Athletes</b> group; admin
          attendance summaries target the <b>Staff</b> group. Recipients see the group
          name in the message header so nothing is ever posted to the wrong chat by mistake.
        </p>
      </div>
      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Staff group name</span>
          <input
            type="text"
            value={cfg.staff_group_name}
            onChange={(e) => setCfg({ ...cfg, staff_group_name: e.target.value })}
            className="iu-input w-full !min-h-[44px] mt-1"
            placeholder="e.g. YCH Attendance"
            data-testid="wa-staff-group-input"
            required
          />
          <span className="text-[11px] text-slate-400 mt-0.5 block">Used for admin attendance summaries.</span>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Athletes / Muster group name</span>
          <input
            type="text"
            value={cfg.athletes_group_name}
            onChange={(e) => setCfg({ ...cfg, athletes_group_name: e.target.value })}
            className="iu-input w-full !min-h-[44px] mt-1"
            placeholder="e.g. YCH Parents & Guardians Group"
            data-testid="wa-athletes-group-input"
            required
          />
          <span className="text-[11px] text-slate-400 mt-0.5 block">Used for muster, escort check-in and meal-muster shares.</span>
        </label>
        <label className="block">
          <span className="text-xs font-semibold text-slate-700">Tuitions group name</span>
          <input
            type="text"
            value={cfg.tuitions_group_name || ""}
            onChange={(e) => setCfg({ ...cfg, tuitions_group_name: e.target.value })}
            className="iu-input w-full !min-h-[44px] mt-1"
            placeholder="e.g. YCH Tuitions"
            data-testid="wa-tuitions-group-input"
          />
          <span className="text-[11px] text-slate-400 mt-0.5 block">Tuition Teachers share their check-in and DAR here.</span>
        </label>
        <button
          type="submit"
          disabled={saving}
          className="iu-btn-primary w-full !min-h-[44px]"
          data-testid="wa-groups-save"
        >
          {saving ? <Loader2 className="animate-spin" size={16}/> : <><Save size={16}/> Save WhatsApp groups</>}
        </button>
      </form>
    </div>
  );
}
