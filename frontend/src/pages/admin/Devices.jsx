import React, { useEffect, useState } from "react";
import { Loader2, Check, X, Ban, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { categoryLabel } from "../../utils";
import { useEscape } from "../../hooks/useEscape";

const FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "revoked", label: "Revoked" },
];

export default function Devices() {
  const [filter, setFilter] = useState("pending");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setItems(await api.get("/admin/devices", { status_filter: filter })); }
    finally { setLoading(false); }
  };
  useEffect(() => { load();   }, [filter]);

  const reject = async (d) => {
    try { await api.post(`/admin/devices/${d.id}/reject`); toast.success("Rejected"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };
  const revoke = async (d) => {
    if (!window.confirm("Revoke this device? The user will be signed out.")) return;
    try { await api.post(`/admin/devices/${d.id}/revoke`); toast.success("Revoked"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Access Requests</h1>
        <p className="text-slate-500 text-sm mt-1">Approve new browser sign-ins from your members.</p>
      </header>

      <div className="flex gap-2 overflow-x-auto pb-3 mb-2">
        {FILTERS.map((f) => (
          <button key={f.key} data-testid={`devices-filter-${f.key}`} onClick={() => setFilter(f.key)} className={`iu-chip whitespace-nowrap shrink-0 ${filter === f.key ? "iu-chip-active" : ""}`}>{f.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : items.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500">No {filter} requests.</div>
      ) : (
        <div className="space-y-3" data-testid="devices-list">
          {items.map((d) => (
            <div key={d.id} className="iu-card p-4 flex flex-wrap items-center gap-4" data-testid={`device-row-${d.id}`}>
              <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center"><Smartphone size={18}/></div>
              <div className="flex-1 min-w-[200px]">
                <div className="font-semibold">
                  {d.member_name
                    || d.proposed_full_name
                    || (d.phone ? `Unmatched · ${d.phone}` : "Unknown device")}
                </div>
                <div className="text-xs text-slate-500">
                  {(d.member_rank || d.proposed_rank) ? `${d.member_rank || d.proposed_rank} · ` : ""}
                  {(d.member_category || d.proposed_category) ? categoryLabel(d.member_category || d.proposed_category) : ""}
                  {(d.member_category || d.proposed_category) && d.member_role ? " · " : ""}
                  {d.member_role === "admin" ? "Admin" : (d.member_role ? "Member" : (d.proposed_full_name ? "New sign-up" : ""))}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {d.device_name || "Device"} · {d.platform || "—"} · phone {d.phone || "—"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {filter === "pending" && (
                  <>
                    <button data-testid={`approve-device-${d.id}`} onClick={() => setEditing(d)} className="iu-btn-primary !h-9 !px-3"><Check size={14}/> Approve</button>
                    <button data-testid={`reject-device-${d.id}`} onClick={() => reject(d)} className="iu-btn-secondary !h-9 !px-3"><X size={14}/> Reject</button>
                  </>
                )}
                {filter === "approved" && (
                  <button data-testid={`revoke-device-${d.id}`} onClick={() => revoke(d)} className="iu-btn-danger !h-9 !px-3"><Ban size={14}/> Revoke</button>
                )}
                {(filter === "rejected" || filter === "revoked") && (
                  <span className="iu-chip capitalize">{d.status}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <ApproveDialog device={editing} onClose={() => setEditing(null)} onApproved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function ApproveDialog({ device, onClose, onApproved }) {
  useEscape(onClose);
  const matched = !!device.member_name;
  const [form, setForm] = useState({
    full_name: device.member_name || device.proposed_full_name || "",
    role: device.member_role || "member",
    category: device.member_category || device.proposed_category || "athlete",
    rank: device.member_rank || device.proposed_rank || "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!matched && !form.full_name.trim()) { toast.error("Full name required for new member"); return; }
    setBusy(true);
    try {
      await api.post(`/admin/devices/${device.id}/approve`, form);
      toast.success("Device approved");
      onApproved();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl p-6" onClick={(e) => e.stopPropagation()} data-testid="approve-device-form">
        <h2 className="text-xl font-extrabold mb-1">Approve device</h2>
        <p className="text-sm text-slate-500 mb-4">
          {matched
            ? `Approving for existing member: ${device.member_name}`
            : device.proposed_full_name
              ? `${device.proposed_full_name} introduced themselves at sign-up. Review and approve to create their member record.`
              : `Phone ${device.phone || "?"} doesn't match a member. We'll create one.`}
        </p>
        <form onSubmit={submit} className="space-y-3">
          {!matched && (
            <div>
              <label className="iu-label">Full name</label>
              <input data-testid="ad-name" value={form.full_name} onChange={(e) => set("full_name", e.target.value)} className="iu-input" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Role</label>
              <select data-testid="ad-role" value={form.role} onChange={(e) => set("role", e.target.value)} className="iu-input">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="iu-label">Category</label>
              <select data-testid="ad-category" value={form.category} onChange={(e) => set("category", e.target.value)} className="iu-input">
                <option value="athlete">Athlete</option>
                <option value="staff">Staff</option>
                <option value="coach">Coach</option>
                <option value="executive">Executive</option>
              </select>
            </div>
          </div>
          <div>
            <label className="iu-label">Rank (optional)</label>
            <input data-testid="ad-rank" value={form.rank} onChange={(e) => set("rank", e.target.value)} className="iu-input" />
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} type="button" className="iu-btn-secondary flex-1">Cancel</button>
            <button data-testid="ad-submit" type="submit" disabled={busy} className="iu-btn-primary flex-1">
              {busy ? <Loader2 className="animate-spin" size={16}/> : "Approve & Sign in user"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
