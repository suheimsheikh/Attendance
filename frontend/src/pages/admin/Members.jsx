import React, { useEffect, useState, useMemo } from "react";
import { Loader2, Plus, Search, Edit3, Trash2, LogIn, LogOut as LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import StatusBadge from "../../components/StatusBadge";
import MemberForm from "./MemberForm";
import { categoryLabel } from "../../utils";

export default function Members() {
  const [members, setMembers] = useState([]);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // member object or "new"
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    try {
      const [m, p] = await Promise.all([api.get("/members"), api.get("/presence")]);
      setMembers(m);
      const map = {};
      (p.members || []).forEach((x) => { map[x.id] = x; });
      setPresence(map);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q) ||
      (m.rank || "").toLowerCase().includes(q) ||
      (m.mobile || "").includes(q) ||
      (m.institution || "").toLowerCase().includes(q)
    );
  }, [members, search]);

  const remove = async (m) => {
    if (!window.confirm(`Delete ${m.full_name}? This also removes their attendance & leaves.`)) return;
    try {
      await api.del(`/members/${m.id}`);
      toast.success("Member deleted");
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  const toggleAttendance = async (m) => {
    setBusyId(m.id);
    try {
      const res = await api.post(`/admin/attendance/toggle/${m.id}`, { reason: "Admin console override" });
      toast.success(res.action === "checkin" ? `${m.full_name} checked in` : `${m.full_name} checked out (${res.hours}h)`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusyId(null); }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Members</h1>
          <p className="text-slate-500 text-sm mt-1">{members.length} total</p>
        </div>
        <button data-testid="new-member-button" onClick={() => setEditing("new")} className="iu-btn-primary"><Plus size={16}/> Add member</button>
      </header>

      <div className="iu-card p-4 mb-4 flex items-center gap-3">
        <Search size={18} className="text-slate-400" />
        <input
          data-testid="member-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, mobile, rank…"
          className="flex-1 outline-none bg-transparent text-sm"
        />
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className="iu-table-th">Member</th>
                  <th className="iu-table-th hidden md:table-cell">Role</th>
                  <th className="iu-table-th hidden lg:table-cell">Institution</th>
                  <th className="iu-table-th hidden lg:table-cell">Mobile</th>
                  <th className="iu-table-th hidden lg:table-cell">Hours</th>
                  <th className="iu-table-th">Status</th>
                  <th className="iu-table-th text-right">Actions</th>
                </tr>
              </thead>
              <tbody data-testid="members-table">
                {filtered.map((m) => {
                  const p = presence[m.id];
                  return (
                    <tr key={m.id} className="hover:bg-slate-50" data-testid={`member-row-${m.id}`}>
                      <td className="iu-table-td">
                        <div className="flex items-center gap-3">
                          <Avatar name={m.full_name} photo={m.photo} size={36} />
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate">{m.full_name}</div>
                            <div className="text-xs text-slate-500 truncate">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="iu-table-td hidden md:table-cell">
                        <div className="text-sm text-slate-700">{m.role === "admin" ? "Admin" : "Member"}</div>
                        <div className="text-xs text-slate-500">{m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}</div>
                      </td>
                      <td className="iu-table-td hidden lg:table-cell text-sm text-slate-700">{m.institution || "—"}</td>
                      <td className="iu-table-td hidden lg:table-cell">{m.mobile || "—"}</td>
                      <td className="iu-table-td hidden lg:table-cell">{m.work_start || "—"} – {m.work_end || "—"}</td>
                      <td className="iu-table-td">{p ? <StatusBadge status={p.status} /> : <span className="text-xs text-slate-400">—</span>}</td>
                      <td className="iu-table-td text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            data-testid={`toggle-attendance-${m.id}`}
                            disabled={busyId === m.id}
                            onClick={() => toggleAttendance(m)}
                            title={p?.status === "on_campus" ? "Force check-out" : "Force check-in"}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-700"
                          >
                            {busyId === m.id ? <Loader2 className="animate-spin" size={16}/> : (p?.status === "on_campus" ? <LogOutIcon size={16}/> : <LogIn size={16}/>)}
                          </button>
                          <button data-testid={`edit-member-${m.id}`} onClick={() => setEditing(m)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-700"><Edit3 size={16} /></button>
                          <button data-testid={`delete-member-${m.id}`} onClick={() => remove(m)} className="p-2 rounded-lg hover:bg-red-50 text-red-600"><Trash2 size={16} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="text-center py-10 text-slate-500 text-sm">No members found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <MemberForm
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
