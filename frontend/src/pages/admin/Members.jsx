import React, { useEffect, useState, useMemo } from "react";
import { Loader2, Plus, Search, Edit3, Trash2, LogIn, LogOut as LogOutIcon, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import InlinePhotoAvatar from "../../components/InlinePhotoAvatar";
import ParentContact from "../../components/ParentContact";
import StatusBadge from "../../components/StatusBadge";
import MemberForm from "./MemberForm";
import { categoryLabel } from "../../utils";

// Each member bucket has a designated color used on its filter pill,
// the colored side-stripe on the row, and the row hover tint.
const BUCKETS = [
  { key: "all",     label: "All",      dotBg: "bg-slate-400",   activeBg: "bg-slate-900",   activeText: "text-white", inactiveBg: "bg-slate-100",  inactiveText: "text-slate-700",  inactiveBorder: "border-slate-200",  stripe: "",                rowHover: "" },
  { key: "admin",   label: "Admins",   dotBg: "bg-indigo-500",  activeBg: "bg-indigo-600",  activeText: "text-white", inactiveBg: "bg-indigo-50",  inactiveText: "text-indigo-700", inactiveBorder: "border-indigo-200", stripe: "bg-indigo-500",   rowHover: "hover:bg-indigo-50/60" },
  { key: "coach",     label: "Coaches",    dotBg: "bg-emerald-500", activeBg: "bg-emerald-600", activeText: "text-white", inactiveBg: "bg-emerald-50", inactiveText: "text-emerald-700",inactiveBorder: "border-emerald-200",stripe: "bg-emerald-500",  rowHover: "hover:bg-emerald-50/60" },
  { key: "staff",     label: "Staff",      dotBg: "bg-amber-500",   activeBg: "bg-amber-600",   activeText: "text-white", inactiveBg: "bg-amber-50",   inactiveText: "text-amber-700",  inactiveBorder: "border-amber-200",  stripe: "bg-amber-500",    rowHover: "hover:bg-amber-50/60" },
  { key: "executive", label: "Executives", dotBg: "bg-violet-500",  activeBg: "bg-violet-600",  activeText: "text-white", inactiveBg: "bg-violet-50",  inactiveText: "text-violet-700", inactiveBorder: "border-violet-200", stripe: "bg-violet-500",   rowHover: "hover:bg-violet-50/60" },
  { key: "athlete",   label: "Athletes",   dotBg: "bg-sky-500",     activeBg: "bg-sky-600",     activeText: "text-white", inactiveBg: "bg-sky-50",     inactiveText: "text-sky-700",    inactiveBorder: "border-sky-200",    stripe: "bg-sky-500",      rowHover: "hover:bg-sky-50/60" },
];
const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

const bucketOf = (m) => (m.role === "admin" ? "admin" : (m.category || "athlete"));
const GENDER_LABEL = { M: "Male", F: "Female", O: "Other" };

// Open the edit modal when a row is double-clicked — but only when the click
// didn't originate from an interactive element (inputs / buttons / labels for
// photo upload), otherwise the parent-mobile editor double-click-to-select
// gesture would surprise admins with a modal.
const isInteractive = (target) => {
  const el = target?.closest?.("input, button, select, textarea, a, label");
  return !!el;
};

export default function Members() {
  const [members, setMembers] = useState([]);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // member object or "new"
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [bucket, setBucket] = useState("all");
  const [instFilter, setInstFilter] = useState("");
  const [institutions, setInstitutions] = useState([]);

  const load = async () => {
    try {
      const [m, p, i] = await Promise.all([api.get("/members"), api.get("/presence"), api.get("/institutions")]);
      setMembers(m);
      const map = {};
      (p.members || []).forEach((x) => { map[x.id] = x; });
      setPresence(map);
      setInstitutions(i || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const counts = useMemo(() => {
    const c = { all: members.length, admin: 0, coach: 0, staff: 0, executive: 0, athlete: 0 };
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
    if (instFilter) list = list.filter((m) => m.institution === instFilter);
    if (!q) return list;
    return list.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q) ||
      (m.rank || "").toLowerCase().includes(q) ||
      (m.mobile || "").includes(q) ||
      (m.institution || "").toLowerCase().includes(q)
    );
  }, [members, search, bucket, instFilter]);

  const remove = async (m) => {
    if (!window.confirm(`Delete ${m.full_name}? This also removes their attendance & leaves.`)) return;
    try {
      await api.del(`/members/${m.id}`);
      toast.success("Member deleted");
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  // Inline patch — update parent_mobile fields locally + persist to API on blur,
  // without triggering a full reload (which would interrupt other open inputs).
  const patchParent = async (memberId, field, value) => {
    const trimmed = (value || "").trim();
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, [field]: trimmed } : m)));
    try {
      await api.patch(`/members/${memberId}`, { [field]: trimmed });
    } catch (err) {
      toast.error(err?.message || "Save failed");
      throw err;
    }
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
    <div className="p-4 md:p-8 max-w-[1600px] mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Members</h1>
          <p className="text-slate-500 text-sm mt-1">{members.length} total · double-click any row to edit</p>
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
        {institutions.length > 0 && (
          <select
            data-testid="member-inst-filter"
            value={instFilter}
            onChange={(e) => setInstFilter(e.target.value)}
            className="ml-auto h-8 px-3 rounded-full text-xs font-semibold border border-slate-200 bg-white text-slate-700"
          >
            <option value="">All institutions</option>
            {institutions.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
          </select>
        )}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-auto max-h-[75vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="iu-table-th w-10 text-center">Edit</th>
                  <th className="iu-table-th">Member</th>
                  <th className="iu-table-th">Role / Category</th>
                  <th className="iu-table-th">Rank</th>
                  <th className="iu-table-th">Gender</th>
                  <th className="iu-table-th">Mobile</th>
                  <th className="iu-table-th">Institution</th>
                  <th className="iu-table-th">Hours</th>
                  <th className="iu-table-th">Weekly off</th>
                  <th className="iu-table-th">Parents / Guardian</th>
                  <th className="iu-table-th">Status</th>
                  <th className="iu-table-th text-center w-12">Del</th>
                </tr>
              </thead>
              <tbody data-testid="members-table">
                {filtered.map((m) => {
                  const p = presence[m.id];
                  const b = BUCKET_BY_KEY[bucketOf(m)] || BUCKET_BY_KEY.athlete;
                  return (
                    <tr
                      key={m.id}
                      className={`transition cursor-pointer ${b.rowHover}`}
                      data-testid={`member-row-${m.id}`}
                      onDoubleClick={(e) => { if (!isInteractive(e.target)) setEditing(m); }}
                      title="Double-click to edit"
                    >
                      {/* Edit pencil — extreme left, always visible */}
                      <td className="iu-table-td text-center relative pl-2 pr-1">
                        <span className={`absolute left-0 top-2 bottom-2 w-1.5 rounded-r ${b.stripe}`} aria-hidden="true" />
                        <button
                          data-testid={`edit-member-${m.id}`}
                          onClick={() => setEditing(m)}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-700"
                          title="Edit member"
                        >
                          <Edit3 size={16} />
                        </button>
                      </td>
                      {/* Member: photo + name + email + parent-contact icon */}
                      <td className="iu-table-td">
                        <div className="flex items-center gap-3">
                          <InlinePhotoAvatar
                            member={m}
                            size={40}
                            onUpdated={(u) => setMembers((prev) => prev.map((x) => (x.id === m.id ? { ...x, photo: u.photo } : x)))}
                          />
                          <div className="min-w-0">
                            <div className="font-semibold text-slate-900 truncate flex items-center gap-2">
                              <span className="truncate">{m.full_name}</span>
                              <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
                            </div>
                            <div className="text-xs text-slate-500 truncate">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      {/* Role / category pill */}
                      <td className="iu-table-td">
                        <span className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${b.inactiveBg} ${b.inactiveText} ${b.inactiveBorder}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${b.dotBg}`} />
                          {b.label.replace(/s$/, "")}
                        </span>
                        <div className="text-xs text-slate-500 mt-1">{m.role === "admin" ? "Admin" : categoryLabel(m.category)}</div>
                      </td>
                      <td className="iu-table-td text-slate-700">{m.rank || "—"}</td>
                      <td className="iu-table-td text-slate-700">{GENDER_LABEL[m.gender] || "—"}</td>
                      <td className="iu-table-td text-slate-700 font-mono text-xs">{m.mobile || "—"}</td>
                      <td className="iu-table-td text-slate-700">{m.institution || "—"}</td>
                      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap">
                        {m.work_start || "—"}{m.work_end ? <> – {m.work_end}</> : null}
                      </td>
                      <td className="iu-table-td text-slate-700 text-xs capitalize">{m.weekly_off || "—"}</td>
                      {/* Inline editable parent mobile numbers, prefixed with the
                          parent's NAME (read-only here — names are edited via
                          the row's edit modal). */}
                      <td className="iu-table-td">
                        <div className="flex flex-col gap-1 min-w-[220px] max-w-[260px]">
                          <ParentInlineInput memberId={m.id} field="father_mobile" label={m.father_name || "Father"} initial={m.father_mobile} onSave={patchParent} />
                          <ParentInlineInput memberId={m.id} field="mother_mobile" label={m.mother_name || "Mother"} initial={m.mother_mobile} onSave={patchParent} />
                          <ParentInlineInput memberId={m.id} field="guardian_mobile" label={m.guardian_name || "Guardian"} initial={m.guardian_mobile} onSave={patchParent} />
                        </div>
                      </td>
                      <td className="iu-table-td">
                        <div className="flex items-center gap-1">
                          <button
                            data-testid={`toggle-attendance-${m.id}`}
                            disabled={busyId === m.id}
                            onClick={() => toggleAttendance(m)}
                            title={p?.status === "on_campus" ? "Force check-out" : "Force check-in"}
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-700"
                          >
                            {busyId === m.id ? <Loader2 className="animate-spin" size={14}/> : (p?.status === "on_campus" ? <LogOutIcon size={14}/> : <LogIn size={14}/>)}
                          </button>
                          {p ? <StatusBadge status={p.status} /> : <span className="text-xs text-slate-400">—</span>}
                        </div>
                      </td>
                      <td className="iu-table-td text-center">
                        <button data-testid={`delete-member-${m.id}`} onClick={() => remove(m)} className="p-2 rounded-lg hover:bg-red-50 text-red-600" title="Delete member">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={12} className="text-center py-10 text-slate-500 text-sm">No members found.</td></tr>
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

/**
 * Tiny per-cell editor for one parent_mobile field. Persists on blur or
 * Enter; shows a green check for ~1s after a successful save so the admin
 * can confirm without a toast spam.
 */
function ParentInlineInput({ memberId, field, label, initial, onSave }) {
  const [val, setVal] = useState(initial || "");
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Re-sync local state if a fresh reload from the server brings new data.
  useEffect(() => { setVal(initial || ""); }, [initial]);

  const persist = async () => {
    const trimmed = val.trim();
    if (trimmed === (initial || "").trim()) return;
    setBusy(true);
    try {
      await onSave(memberId, field, trimmed);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
    } catch {
      setVal(initial || "");
    } finally {
      setBusy(false);
    }
  };

  // Background tint stays consistent per role. The `label` text itself now
  // shows the parent's NAME (truncated) when available — falling back to a
  // single-letter role badge for older records.
  const isFather = field === "father_mobile";
  const isMother = field === "mother_mobile";
  const labelColor = isFather ? "bg-sky-100 text-sky-700"
    : isMother ? "bg-pink-100 text-pink-700"
    : "bg-violet-100 text-violet-700";
  const isShortBadge = label && label.length <= 1;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`${isShortBadge ? "w-5 h-5" : "px-1.5 h-5 max-w-[110px] truncate"} rounded text-[10px] font-bold flex items-center justify-center ${labelColor}`}
        title={label}
      >
        {label}
      </span>
      <input
        type="tel"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="—"
        data-testid={`inline-${field}-${memberId}`}
        className="flex-1 min-w-0 px-2 h-7 text-xs font-mono rounded border border-slate-200 bg-white focus:bg-white focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none"
        disabled={busy}
      />
      {busy
        ? <Loader2 size={11} className="animate-spin text-slate-400" />
        : (savedFlash ? <Check size={11} className="text-emerald-600" /> : <span className="w-3" />)}
    </div>
  );
}
