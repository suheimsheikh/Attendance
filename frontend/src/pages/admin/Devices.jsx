import React, { useEffect, useState } from "react";
import { Loader2, Check, X, Ban, Smartphone, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { categoryLabel, formatDate } from "../../utils";
import { useEscape } from "../../hooks/useEscape";

const ACTION_LABELS = {
  approved: "approved",
  rejected: "rejected",
  revoked:  "revoked",
};

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
  const reinstate = async (d) => {
    const who = d.member_name || d.proposed_full_name || (d.phone ? `phone ${d.phone}` : "this device");
    if (!window.confirm(`Re-enable this device for ${who}?`)) return;
    try { await api.post(`/admin/devices/${d.id}/reinstate`); toast.success("Re-enabled"); load(); }
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
                {d.last_action && (
                  <div className="text-[11px] text-slate-500 mt-1" data-testid={`audit-${d.id}`}>
                    Last action: <span className="font-semibold">{ACTION_LABELS[d.last_action] || d.last_action}</span>
                    {d.last_action_by_name ? <> by {d.last_action_by_name}</> : null}
                    {d.last_action_at ? <> · {formatDate(d.last_action_at)}</> : null}
                  </div>
                )}
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
                  <>
                    <span className="iu-chip capitalize">{d.status}</span>
                    {d.user_id && (
                      <button
                        data-testid={`reinstate-device-${d.id}`}
                        onClick={() => reinstate(d)}
                        className="iu-btn-primary !h-9 !px-3"
                        title="Bring this device back to approved status"
                      >
                        <RotateCcw size={14} /> Re-enable
                      </button>
                    )}
                  </>
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

  // Link-to-existing-member (prevents duplicate accounts when a member's phone
  // wasn't on file). Only relevant for unmatched device requests.
  const [members, setMembers] = useState([]);
  const [linkId, setLinkId] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (matched) return;
    api.get("/members").then((list) => setMembers(list || [])).catch(() => {});
  }, [matched]);

  const filtered = search.trim()
    ? members.filter((m) => (m.full_name || "").toLowerCase().includes(search.trim().toLowerCase())).slice(0, 8)
    : [];
  const linked = members.find((m) => m.id === linkId);

  const submit = async (e) => {
    e.preventDefault();
    if (!matched && !linkId && !form.full_name.trim()) { toast.error("Full name required for new member"); return; }
    setBusy(true);
    try {
      const payload = linkId
        ? { link_user_id: linkId, role: linked?.role || "member", category: linked?.category || "athlete" }
        : form;
      await api.post(`/admin/devices/${device.id}/approve`, payload);
      toast.success(linkId ? `Linked to ${linked?.full_name}` : "Device approved");
      onApproved();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="approve-device-form">
        <h2 className="text-xl font-extrabold mb-1">Approve device</h2>
        <p className="text-sm text-slate-500 mb-4">
          {matched
            ? `Approving for existing member: ${device.member_name}`
            : device.proposed_full_name
              ? `${device.proposed_full_name} introduced themselves at sign-up. Link them to an existing member, or create a new record.`
              : `Phone ${device.phone || "?"} doesn't match a member. Link to an existing member, or create a new one.`}
        </p>

        {!matched && (
          <div className="mb-4 p-3 rounded-xl bg-sky-50 ring-1 ring-sky-100" data-testid="link-existing-block">
            <label className="iu-label !text-sky-800">Link to an existing member <span className="normal-case font-normal text-slate-500">(avoids duplicates)</span></label>
            {linked ? (
              <div className="flex items-center justify-between gap-2 mt-1 bg-white rounded-lg px-3 py-2 ring-1 ring-sky-200">
                <span className="font-semibold text-slate-800 truncate" data-testid="linked-member-name">{linked.full_name}</span>
                <button type="button" data-testid="clear-link-button" onClick={() => { setLinkId(""); setSearch(""); }} className="text-xs text-slate-500 underline hover:text-slate-800">Clear</button>
              </div>
            ) : (
              <>
                <input
                  data-testid="link-member-search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search a member by name…"
                  className="iu-input mt-1"
                />
                {filtered.length > 0 && (
                  <div className="mt-2 space-y-1" data-testid="link-member-results">
                    {filtered.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-testid={`link-member-${m.id}`}
                        onClick={() => { setLinkId(m.id); }}
                        className="w-full text-left px-3 py-2 rounded-lg bg-white hover:bg-sky-100 ring-1 ring-slate-100 text-sm flex items-center justify-between"
                      >
                        <span className="font-medium text-slate-800">{m.full_name}</span>
                        <span className="text-xs text-slate-400 capitalize">{m.category}{m.mobile ? "" : " · no phone"}</span>
                      </button>
                    ))}
                  </div>
                )}
                {search.trim() && filtered.length === 0 && (
                  <p className="text-xs text-slate-400 mt-2">No member matches “{search}”. Fill the form below to create a new one.</p>
                )}
              </>
            )}
          </div>
        )}

        <form onSubmit={submit} className="space-y-3">
          {!matched && !linkId && (
            <div>
              <label className="iu-label">Full name <span className="normal-case font-normal text-slate-500">(new member)</span></label>
              <input data-testid="ad-name" value={form.full_name} onChange={(e) => set("full_name", e.target.value)} className="iu-input" />
            </div>
          )}
          {!linkId && (
            <>
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
            </>
          )}
          <div className="flex gap-2">
            <button onClick={onClose} type="button" className="iu-btn-secondary flex-1">Cancel</button>
            <button data-testid="ad-submit" type="submit" disabled={busy} className="iu-btn-primary flex-1">
              {busy ? <Loader2 className="animate-spin" size={16}/> : (linkId ? "Link & Sign in" : "Approve & Sign in user")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
