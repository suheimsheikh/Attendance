import React, { useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { api, showApiError } from "../../../api";

/**
 * AddVendorInlineModal — quick "＋ Add new vendor…" flow reachable from
 * the RowVendorPicker dropdown. Extracted from MealEntryTab.jsx on
 * 25 Jun 2026 (pure move).
 */
export default function AddVendorInlineModal({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      const v = await api.post("/meals/vendors", { name: n, phone: phone.trim() || null });
      toast.success(`Added ${v.name}`);
      onCreated(v);
    } catch (e) { showApiError(e); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" data-testid="add-vendor-inline-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-lg font-extrabold text-slate-900">Add new vendor</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" data-testid="add-vendor-close" title="Close"><X size={18}/></button>
        </div>
        <div className="p-5 space-y-3">
          <label className="block text-xs font-semibold text-slate-600">
            <div className="mb-1">Name</div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Reliance Fresh"
              className="iu-input !h-10 !w-full text-sm"
              data-testid="add-vendor-name"
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            <div className="mb-1">Phone (optional)</div>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="98765 43210"
              className="iu-input !h-10 !w-full text-sm"
              data-testid="add-vendor-phone"
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
          </label>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button className="iu-btn-secondary !h-9" onClick={onClose} data-testid="add-vendor-cancel">Cancel</button>
          <button className="iu-btn-primary !h-9" onClick={submit} disabled={saving} data-testid="add-vendor-save">
            {saving ? "Saving…" : "Save vendor"}
          </button>
        </div>
      </div>
    </div>
  );
}
