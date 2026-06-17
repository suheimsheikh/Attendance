import React, { useEffect, useState, useMemo } from "react";
import { Loader2, Plus, Search, Edit3, Trash2, LogIn, LogOut as LogOutIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import StatusBadge from "../../components/StatusBadge";
import MemberForm from "./MemberForm";
import { categoryLabel } from "../../utils";

// Each member bucket has a designated color used on its filter pill,
// the colored side-stripe on the row, and the row hover tint.
const BUCKETS = [
  { key: "all",     label: "All",      dotBg: "bg-slate-400",   activeBg: "bg-slate-900",   activeText: "text-white", inactiveBg: "bg-slate-100",  inactiveText: "text-slate-700",  inactiveBorder: "border-slate-200",  stripe: "",                rowHover: "" },
  { key: "admin",   label: "Admins",   dotBg: "bg-indigo-500",  activeBg: "bg-indigo-600",  activeText: "text-white", inactiveBg: "bg-indigo-50",  inactiveText: "text-indigo-700", inactiveBorder: "border-indigo-200", stripe: "bg-indigo-500",   rowHover: "hover:bg-indigo-50/60" },
  { key: "coach",   label: "Coaches",  dotBg: "bg-emerald-500", activeBg: "bg-emerald-600", activeText: "text-white", inactiveBg: "bg-emerald-50", inactiveText: "text-emerald-700",inactiveBorder: "border-emerald-200",stripe: "bg-emerald-500",  rowHover: "hover:bg-emerald-50/60" },
  { key: "staff",   label: "Staff",    dotBg: "bg-amber-500",   activeBg: "bg-amber-600",   activeText: "text-white", inactiveBg: "bg-amber-50",   inactiveText: "text-amber-700",  inactiveBorder: "border-amber-200",  stripe: "bg-amber-500",    rowHover: "hover:bg-amber-50/60" },
  { key: "athlete", label: "Athletes", dotBg: "bg-sky-500",     activeBg: "bg-sky-600",     activeText: "text-white", inactiveBg: "bg-sky-50",     inactiveText: "text-sky-700",    inactiveBorder: "border-sky-200",    stripe: "bg-sky-500",      rowHover: "hover:bg-sky-50/60" },
];
const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

const bucketOf = (m) => (m.role === "admin" ? "admin" : (m.category || "athlete"));

export default function Members() {
  const [members, setMembers] = useState([]);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // member object or "new"
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [bucket, setBucket] = useState("all");

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

  const counts = useMemo(() => {
    const c = { all: members.length, admin: 0, coach: 0, staff: 0, athlete: 0 };
    for (const m of members) {
      const b = bucketOf(m);
      if (c[b] !== undefined) c[b] += 1;
    }
    return c;
  }, [members]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = members;
    if (bucket !== "all") list = list.filter((m) => bucketOf(m) === bucket);
    if (!q) return list;
    return list.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q) ||
      (m.rank || "").toLowerCase().includes(q) ||
      (m.mobile || "").includes(q) ||
      (m.institution || "").toLowerCase().includes(q)
    );
  }, [members, search, bucket]);

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

      <div className="flex flex-wrap gap-2 mb-3" data-testid="member-bucket-filters">
        {BUCKETS.map((b) => {
          const active = bucket === b.key;
          const n = counts[b.key] ?? 0;
          const cls = active
            ? `${b.activeBg} ${b.activeText} border-transparent`
            : `${b.inactiveBg} ${b.inactiveText} ${b.inactiveBorder}`;
          return (
            <button
              key={b.key}
              data-testid={`bucket-${b.key}`}
              onClick={() => setBucket(b.key)}
              className={`inline-flex items-center gap-2 px-3 h-8 rounded-full text-xs font-semibold border transition ${cls}`}
            >
              <span className={`w-2 h-2 rounded-full ${b.dotBg}`} />
              {b.label}
              <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-auto max-h-[70vh]">
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
                  const b = BUCKET_BY_KEY[bucketOf(m)] || BUCKET_BY_KEY.athlete;
                  return (
                    <tr key={m.id} className={`transition ${b.rowHover}`} data-testid={`member-row-${m.id}`}>
                      <td className="iu-table-td relative pl-5">
                        <span className={`absolute left-0 top-2 bottom-2 w-1.5 rounded-r ${b.stripe}`} aria-hidden="true" />
                        <div className="flex items-center gap-3">
                          <Avatar name={m.full_name} photo={m.photo} size={36} />
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate">{m.full_name}</div>
                            <div className="text-xs text-slate-500 truncate">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="iu-table-td hidden md:table-cell">
                        <span className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${b.inactiveBg} ${b.inactiveText} ${b.inactiveBorder}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${b.dotBg}`} />
                          {b.label.replace(/s$/, "")}
                        </span>
                        <div className="text-xs text-slate-500 mt-1">{m.rank ? m.rank : (m.role === "admin" ? "" : categoryLabel(m.category))}</div>
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
