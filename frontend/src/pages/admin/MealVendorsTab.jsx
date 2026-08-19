import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Pencil, Save, X, Store, Phone } from "lucide-react";
import { api, showApiError } from "../../api";

/**
 * MealVendorsTab — Vendors master (Aug 2026 user request).
 * Light supplier registry (just name + phone) that feeds the vendor
 * dropdown on the Daily-entry purchases grid. Deletion is soft when
 * the vendor is already referenced on a purchase line so historical
 * bills keep their supplier context; unused vendors are hard-deleted
 * to keep the master tidy.
 */
export default function MealVendorsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", phone: "" });
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ name: "", phone: "" });

  const refresh = () => {
    setLoading(true);
    api.get("/meals/vendors")
      .then((r) => setRows(r.vendors || []))
      .catch(showApiError)
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  const submitCreate = async () => {
    const name = draft.name.trim();
    if (!name) { toast.error("Name required"); return; }
    try {
      await api.post("/meals/vendors", { name, phone: draft.phone.trim() || null });
      toast.success(`Added ${name}`);
      setDraft({ name: "", phone: "" });
      setAdding(false);
      refresh();
    } catch (e) { showApiError(e); }
  };

  const startEdit = (v) => {
    setEditingId(v.id);
    setEdit({ name: v.name, phone: v.phone || "" });
  };
  const saveEdit = async () => {
    if (!edit.name.trim()) { toast.error("Name required"); return; }
    try {
      await api.patch(`/meals/vendors/${editingId}`, { name: edit.name.trim(), phone: edit.phone.trim() || null });
      toast.success("Saved");
      setEditingId(null);
      refresh();
    } catch (e) { showApiError(e); }
  };

  const remove = async (v) => {
    if (!window.confirm(`Delete vendor "${v.name}"?`)) return;
    try {
      const r = await api.delete(`/meals/vendors/${v.id}`);
      toast.success(r.soft_deleted ? "Deactivated (used in past purchases)" : "Deleted");
      refresh();
    } catch (e) { showApiError(e); }
  };

  return (
    <div data-testid="meal-vendors-tab" className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900 inline-flex items-center gap-2">
            <Store size={18} className="text-emerald-600"/> Vendors master
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Suppliers you can attribute purchase lines to. Vendor selection on the
            Daily entry grid is optional but strongly encouraged.
          </p>
        </div>
        {!adding && (
          <button
            className="iu-btn-primary !h-9"
            onClick={() => setAdding(true)}
            data-testid="vendor-add-btn"
          ><Plus size={14}/> Add vendor</button>
        )}
      </div>

      {adding && (
        <div className="iu-card p-3 mb-4 flex items-end gap-2 flex-wrap" data-testid="vendor-add-form">
          <label className="text-xs font-semibold text-slate-600 flex-1 min-w-[180px]">
            <div className="mb-1">Name</div>
            <input
              autoFocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Reliance Fresh"
              className="iu-input !h-9 !w-full text-sm"
              data-testid="vendor-add-name"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600 flex-1 min-w-[160px]">
            <div className="mb-1">Phone</div>
            <input
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="Optional"
              className="iu-input !h-9 !w-full text-sm"
              data-testid="vendor-add-phone"
            />
          </label>
          <button className="iu-btn-primary !h-9" onClick={submitCreate} data-testid="vendor-add-save">
            <Save size={14}/> Save
          </button>
          <button
            className="iu-btn-secondary !h-9"
            onClick={() => { setAdding(false); setDraft({ name: "", phone: "" }); }}
            data-testid="vendor-add-cancel"
          ><X size={14}/> Cancel</button>
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-slate-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500" data-testid="vendor-empty">
          <Store size={30} className="mx-auto text-slate-300 mb-2"/>
          No vendors yet. Add one to start attributing purchases.
        </div>
      ) : (
        <div className="iu-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <th className="text-left p-2.5">Name</th>
                <th className="text-left p-2.5 hidden sm:table-cell">Phone</th>
                <th className="w-32"/>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const isEditing = editingId === v.id;
                return (
                  <tr key={v.id} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`vendor-row-${v.id}`}>
                    <td className="p-2.5 font-semibold text-slate-900">
                      {isEditing ? (
                        <input
                          value={edit.name}
                          onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                          className="iu-input !h-8 text-sm w-full"
                          data-testid={`vendor-edit-name-${v.id}`}
                        />
                      ) : v.name}
                    </td>
                    <td className="p-2.5 text-slate-600 hidden sm:table-cell">
                      {isEditing ? (
                        <input
                          value={edit.phone}
                          onChange={(e) => setEdit({ ...edit, phone: e.target.value })}
                          className="iu-input !h-8 text-sm w-full"
                          data-testid={`vendor-edit-phone-${v.id}`}
                        />
                      ) : (v.phone
                        ? <span className="inline-flex items-center gap-1"><Phone size={12}/> {v.phone}</span>
                        : <span className="text-slate-400">—</span>)}
                    </td>
                    <td className="p-2.5 text-right">
                      {isEditing ? (
                        <div className="inline-flex gap-1">
                          <button className="iu-btn-primary !h-8 !px-2" onClick={saveEdit} data-testid={`vendor-save-${v.id}`}>
                            <Save size={12}/>
                          </button>
                          <button className="iu-btn-secondary !h-8 !px-2" onClick={() => setEditingId(null)} data-testid={`vendor-cancel-${v.id}`}>
                            <X size={12}/>
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex gap-1">
                          <button
                            className="iu-btn-secondary !h-8 !px-2 !text-slate-600"
                            onClick={() => startEdit(v)}
                            title="Edit"
                            data-testid={`vendor-edit-${v.id}`}
                          ><Pencil size={12}/></button>
                          <button
                            className="iu-btn-secondary !h-8 !px-2 !text-rose-600 !border-rose-200 hover:!bg-rose-50"
                            onClick={() => remove(v)}
                            title="Delete"
                            data-testid={`vendor-delete-${v.id}`}
                          ><Trash2 size={12}/></button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
