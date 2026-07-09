/**
 * Roles master — admin CRUD for the RBAC role list.
 *
 * Ships with 3 seeded system roles (admin, chef, member) that back
 * hardcoded permission checks in the backend:
 *   • admin  — full management access.
 *   • chef   — member privileges + read on Muster / Presence / Chef's View.
 *   • member — default role.
 *
 * Seeded rows are marked with a lock badge — label + description remain
 * editable but the key and system-flag are locked and delete/deactivate
 * are refused by the backend.
 *
 * Custom roles can be added but until full RBAC ships (Q2 2026) they
 * behave like `member` for permission purposes — we surface a warning
 * on the create form so admins don't assume otherwise.
 */
import React, { useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, X, Lock, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";

// Keys of the 3 seeded system roles — mirrors SEEDED_ROLE_KEYS in
// backend/routes/roles.py. Cannot be renamed or deleted because the
// backend hardcodes permission checks against them.
const SYSTEM_KEYS = new Set(["admin", "chef", "member"]);

function RoleForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const isSystem = !!initial?.is_system;
  const [form, setForm] = useState({
    key:        initial?.key         ?? "",
    label:      initial?.label       ?? "",
    description: initial?.description ?? "",
    sort_order: initial?.sort_order  ?? 50,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) { toast.error("Label is required"); return; }
    if (!isEdit && !form.key.trim()) { toast.error("Key is required"); return; }
    setSaving(true);
    try {
      if (isEdit) {
        await api.patch(`/masters/roles/${initial.id}`, {
          label: form.label.trim(),
          description: form.description.trim() || null,
          sort_order: Number(form.sort_order),
        });
        toast.success("Role updated");
      } else {
        await api.post("/masters/roles", {
          key: form.key.trim().toLowerCase(),
          label: form.label.trim(),
          description: form.description.trim() || null,
          sort_order: Number(form.sort_order),
        });
        toast.success("Role created");
      }
      onSaved?.();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" data-testid="role-form-modal">
      <form onSubmit={save} className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <KeyRound size={18} className="text-sky-600" />
            {isEdit ? "Edit role" : "New role"}
            {isSystem && (
              <span className="text-xs bg-slate-100 border border-slate-300 rounded-full px-2 py-0.5 font-normal text-slate-600 flex items-center gap-1">
                <Lock size={11} /> System
              </span>
            )}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-800" data-testid="role-form-close">
            <X size={20} />
          </button>
        </div>

        <div>
          <label className="iu-label">Key (locked once created)</label>
          <input
            data-testid="role-form-key"
            value={form.key}
            onChange={(e) => set("key", e.target.value)}
            disabled={isEdit}
            placeholder="e.g. kitchen_lead"
            className="iu-input font-mono text-sm"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            Lowercase alphanumeric + underscore. Persisted on user rows — cannot be renamed after creation.
          </p>
        </div>

        <div>
          <label className="iu-label">Label</label>
          <input
            data-testid="role-form-label"
            value={form.label}
            onChange={(e) => set("label", e.target.value)}
            placeholder="e.g. Kitchen Lead"
            className="iu-input"
          />
        </div>

        <div>
          <label className="iu-label">Description <span className="text-slate-400 font-normal text-[10px]">(optional)</span></label>
          <textarea
            data-testid="role-form-description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What can this role do?"
            className="iu-input h-20"
          />
        </div>

        <div>
          <label className="iu-label">Sort order</label>
          <input
            type="number"
            data-testid="role-form-sort"
            value={form.sort_order}
            onChange={(e) => set("sort_order", e.target.value)}
            className="iu-input w-32"
          />
        </div>

        {!isSystem && !isEdit && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            <b>Note:</b> custom roles are selectable in the Member form but currently grant no
            additional privileges beyond the default <code className="bg-white px-1 rounded">member</code> role.
            Full permission-toggling arrives with the Q2 2026 RBAC ship.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="iu-btn-secondary" data-testid="role-form-cancel">Cancel</button>
          <button type="submit" disabled={saving} className="iu-btn-primary" data-testid="role-form-save">
            {saving && <Loader2 className="animate-spin" size={16} />}
            {isEdit ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Roles() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/masters/roles");
      setRows(r || []);
    } catch (err) {
      showApiError(err, "Failed to load roles");
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const del = async (row) => {
    if (row.member_count > 0) {
      toast.error(`${row.member_count} member(s) still hold this role — reassign first.`);
      return;
    }
    if (!confirm(`Delete role "${row.label}"?`)) return;
    try {
      await api.del(`/masters/roles/${row.id}`);
      toast.success("Role deleted");
      load();
    } catch (err) { showApiError(err, "Delete failed"); }
  };

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-8" data-testid="roles-page">
      <header className="flex items-end justify-between flex-wrap gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <KeyRound className="text-sky-600" size={28} /> Roles
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            RBAC role master. System roles power backend permission checks — their labels
            can be reworded but keys are locked. Custom roles are selectable on the Member
            form and will gain full permission-toggling with the Q2 2026 RBAC release.
          </p>
        </div>
        <button
          onClick={() => setEditing({})}
          className="iu-btn-primary"
          data-testid="roles-new"
        >
          <Plus size={16} /> New role
        </button>
      </header>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="animate-spin" size={16} /> Loading…
        </div>
      ) : (
        <div className="iu-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500 border-b bg-slate-50">
              <tr>
                <th className="text-left py-3 px-4">Role</th>
                <th className="text-left py-3 px-4">Description</th>
                <th className="text-right py-3 px-4">Members</th>
                <th className="text-right py-3 px-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-slate-50" data-testid={`role-row-${r.key}`}>
                  <td className="py-3 px-4">
                    <div className="font-semibold flex items-center gap-2">
                      {r.label}
                      {r.is_system && (
                        <span className="text-[10px] bg-slate-100 border border-slate-300 rounded-full px-2 py-0.5 font-normal text-slate-600 flex items-center gap-1">
                          <Lock size={10} /> System
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xs text-slate-500 mt-0.5">{r.key}</div>
                  </td>
                  <td className="py-3 px-4 text-slate-600 max-w-md">{r.description || <span className="text-slate-400">—</span>}</td>
                  <td className="py-3 px-4 text-right tabular-nums">{r.member_count}</td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setEditing(r)}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-600"
                        title="Edit"
                        data-testid={`role-edit-${r.key}`}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => del(r)}
                        disabled={SYSTEM_KEYS.has(r.key)}
                        className="p-2 rounded-lg hover:bg-rose-100 text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed"
                        title={SYSTEM_KEYS.has(r.key) ? "System roles cannot be deleted" : "Delete"}
                        data-testid={`role-delete-${r.key}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-slate-400 text-sm">
                    No roles yet. Add one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {editing !== null && (
        <RoleForm
          initial={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
