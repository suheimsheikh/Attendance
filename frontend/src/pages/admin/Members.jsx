import React, { useCallback, useEffect, useState, useMemo } from "react";
import { Loader2, Plus, Search, Edit3, Trash2, LogIn, LogOut as LogOutIcon, Check, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { api, showApiError } from "../../api";
import InlinePhotoAvatar from "../../components/InlinePhotoAvatar";
import ParentContact from "../../components/ParentContact";
import StatusBadge from "../../components/StatusBadge";
import InlineCell from "../../components/InlineCell";
import MemberForm from "./MemberForm";
import { categoryLabel } from "../../utils";

// Category buckets — these match the `category` field on the user doc.
// `admin` is intentionally absent: it's a ROLE (orthogonal to category) and is
// rendered as its own toggle further down + as a badge on each row. A coach
// who is also an admin appears under "Coaches" AND lights up the Admin chip.
const BUCKETS = [
  { key: "all",       label: "All",        dotBg: "bg-slate-400",   activeBg: "bg-slate-900",   activeText: "text-white", inactiveBg: "bg-slate-100",  inactiveText: "text-slate-700",   inactiveBorder: "border-slate-200",  stripe: "",               rowHover: "" },
  { key: "coach",     label: "Coaches",    dotBg: "bg-emerald-500", activeBg: "bg-emerald-600", activeText: "text-white", inactiveBg: "bg-emerald-50", inactiveText: "text-emerald-700", inactiveBorder: "border-emerald-200",stripe: "bg-emerald-500", rowHover: "hover:bg-emerald-50/60" },
  { key: "staff",     label: "Staff",      dotBg: "bg-amber-500",   activeBg: "bg-amber-600",   activeText: "text-white", inactiveBg: "bg-amber-50",   inactiveText: "text-amber-700",   inactiveBorder: "border-amber-200",  stripe: "bg-amber-500",   rowHover: "hover:bg-amber-50/60" },
  { key: "executive", label: "Executives", dotBg: "bg-violet-500",  activeBg: "bg-violet-600",  activeText: "text-white", inactiveBg: "bg-violet-50",  inactiveText: "text-violet-700",  inactiveBorder: "border-violet-200", stripe: "bg-violet-500",  rowHover: "hover:bg-violet-50/60" },
  { key: "athlete",   label: "Athletes",   dotBg: "bg-sky-500",     activeBg: "bg-sky-600",     activeText: "text-white", inactiveBg: "bg-sky-50",     inactiveText: "text-sky-700",     inactiveBorder: "border-sky-200",    stripe: "bg-sky-500",     rowHover: "hover:bg-sky-50/60" },
];
const BUCKET_BY_KEY = Object.fromEntries(BUCKETS.map((b) => [b.key, b]));

// Returns the CATEGORY bucket — never "admin". Admin is rendered separately as
// a badge on the row and as an orthogonal filter toggle above the table.
const bucketOf = (m) => m.category || "athlete";
const GENDER_LABEL = { M: "Male", F: "Female", O: "Other" };

// Render the "Last seen" column. Friendly relative labels for the common
// cases (today / yesterday / N days ago), absolute date if older than a
// month so the value stays meaningful at any scale.
function lastSeenLabel(iso, today) {
  if (!iso) return <span className="text-slate-400">Never</span>;
  if (iso === today) return <span className="text-emerald-700 font-semibold">Today</span>;
  // YYYY-MM-DD diff in days. Both inputs are local-date strings (no TZ).
  const d1 = new Date(iso + "T12:00:00");
  const d2 = new Date(today + "T12:00:00");
  const diff = Math.round((d2 - d1) / 86400000);
  if (diff === 1) return <span className="text-slate-700">Yesterday</span>;
  if (diff < 7) return <span className="text-slate-700">{diff} days ago</span>;
  if (diff < 30) return <span className="text-amber-700">{diff} days ago</span>;
  // Absolute date for anything ≥ 30 days — easier to interpret than "127 days ago".
  return <span className="text-red-700 font-semibold">
    {new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
  </span>;
}

// Render the "Leave balance" column. Only meaningful for non-athletes
// (the leave-tracked cohort = coach + staff + executive). Athletes use the
// Breaks workflow instead so we deliberately show em-dash for them.
function leaveBalanceLabel(m) {
  if (m.category === "athlete") return <span className="text-slate-300">—</span>;
  const opening = m.leave_balance_opening;
  const remaining = m.leave_balance_remaining;
  if (opening == null) return <span className="text-slate-400" title="No opening balance set">—</span>;
  const tone = remaining < 0 ? "text-red-700" : remaining < 3 ? "text-amber-700" : "text-slate-700";
  return (
    <span className={`font-mono ${tone}`} title={`Opening ${opening} − YTD taken ${(opening - remaining).toFixed(1)} = ${remaining}`}>
      {remaining}<span className="text-slate-400">/{opening}</span>
    </span>
  );
}

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
  // Orthogonal "Admin role" filter. Independent of `bucket` because admin is
  // a ROLE, not a category — a coach who is also an admin is BOTH a coach
  // and an admin and should appear under either filter.
  const [onlyAdmins, setOnlyAdmins] = useState(false);
  const [instFilter, setInstFilter] = useState("");
  const [institutions, setInstitutions] = useState([]);
  // Fleet master — used to render the inline Fleet dropdown. Falls back to
  // free-text + any distinct fleets actually assigned (defensive: handles
  // historic athletes whose fleet label was deleted from the master).
  const [fleets, setFleets] = useState([]);
  // Today in local YYYY-MM-DD — used by the Last-seen column to compute
  // "Today / Yesterday / N days ago". Memoised so the date string is stable
  // across re-renders within the same calendar day.
  const today = useMemo(() => new Date().toLocaleDateString("sv-SE"), []);

  // Static option lists for the inline selects. Keep these in sync with the
  // backend `MemberUpdate` Literal types — out-of-list values would be
  // rejected with a 422.
  const CATEGORY_OPTS = useMemo(() => [
    { value: "athlete",   label: "Athlete" },
    { value: "coach",     label: "Coach" },
    { value: "staff",     label: "Staff" },
    { value: "executive", label: "Executive" },
  ], []);
  const ROLE_OPTS = useMemo(() => [
    { value: "member", label: "Member" },
    { value: "admin",  label: "Admin" },
  ], []);
  const GENDER_OPTS = useMemo(() => [
    { value: "",  label: "—" },
    { value: "M", label: "Male" },
    { value: "F", label: "Female" },
    { value: "O", label: "Other" },
  ], []);
  const WEEKLY_OFF_OPTS = useMemo(() => [
    { value: "",          label: "—" },
    { value: "sunday",    label: "Sunday" },
    { value: "monday",    label: "Monday" },
    { value: "tuesday",   label: "Tuesday" },
    { value: "wednesday", label: "Wednesday" },
    { value: "thursday",  label: "Thursday" },
    { value: "friday",    label: "Friday" },
    { value: "saturday",  label: "Saturday" },
  ], []);
  const FLEET_OPTS = useMemo(() => {
    // Union of fleet-master entries + any distinct fleet labels already in
    // use (defensive: an athlete may have been assigned to a fleet that was
    // later renamed/removed from the master). Empty option clears the fleet.
    const set = new Set((fleets || []).map((f) => f.name));
    for (const m of members) { if (m.fleet) set.add(m.fleet); }
    return [{ value: "", label: "—" }, ...Array.from(set).sort().map((v) => ({ value: v, label: v }))];
  }, [fleets, members]);
  const INSTITUTION_OPTS = useMemo(() => (
    [{ value: "", label: "—" }, ...institutions.map((i) => ({ value: i.name, label: i.name }))]
  ), [institutions]);

  const load = useCallback(async () => {
    try {
      const [m, p, i, f] = await Promise.all([
        api.get("/members"),
        api.get("/presence"),
        api.get("/institutions"),
        api.get("/fleets"),
      ]);
      setMembers(m);
      const map = {};
      (p.members || []).forEach((x) => { map[x.id] = x; });
      setPresence(map);
      setInstitutions(i || []);
      setFleets(f || []);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c = { all: members.length, coach: 0, staff: 0, executive: 0, athlete: 0 };
    let adminCount = 0;
    for (const m of members) {
      const b = bucketOf(m);
      if (c[b] !== undefined) c[b] += 1;
      if (m.role === "admin") adminCount += 1;
    }
    c.admin = adminCount;  // orthogonal — sums across categories, not exclusive
    return c;
  }, [members]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = members;
    if (bucket !== "all") list = list.filter((m) => bucketOf(m) === bucket);
    if (onlyAdmins) list = list.filter((m) => m.role === "admin");
    if (instFilter) list = list.filter((m) => m.institution === instFilter);
    if (!q) return list;
    return list.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q) ||
      (m.rank || "").toLowerCase().includes(q) ||
      (m.mobile || "").includes(q) ||
      (m.institution || "").toLowerCase().includes(q)
    );
  }, [members, search, bucket, onlyAdmins, instFilter]);

  const remove = async (m) => {
    if (!window.confirm(`Delete ${m.full_name}? This also removes their attendance & leaves.`)) return;
    try {
      await api.del(`/members/${m.id}`);
      toast.success("Member deleted");
      load();
    } catch (err) { showApiError(err, "Failed"); }
  };

  // Inline patch — apply update locally first (optimistic) + persist to API,
  // without triggering a full reload (which would interrupt other open
  // inputs). Used by both the parent-mobile cells and the new InlineCell
  // editors for name/category/role/rank/mobile/gender/fleet/leave-balance.
  const patchMember = async (memberId, field, value) => {
    // Normalise: trim strings, coerce numbers, empty string → null.
    let normalised = value;
    if (typeof value === "string") normalised = value.trim() === "" ? null : value.trim();
    if (field === "leave_balance_opening") {
      normalised = value === "" || value == null ? null : Number(value);
      if (Number.isNaN(normalised)) normalised = null;
    }
    setMembers((prev) => prev.map((m) => {
      if (m.id !== memberId) return m;
      const next = { ...m, [field]: normalised };
      // Re-derive `leave_balance_remaining` so the displayed "X/Y" stays
      // consistent until the next full reload picks up the canonical value.
      if (field === "leave_balance_opening" && normalised != null && m.leave_balance_opening != null) {
        const taken = m.leave_balance_opening - (m.leave_balance_remaining ?? m.leave_balance_opening);
        next.leave_balance_remaining = normalised - taken;
      } else if (field === "leave_balance_opening" && normalised != null) {
        next.leave_balance_remaining = normalised;
      } else if (field === "leave_balance_opening") {
        next.leave_balance_remaining = null;
      }
      return next;
    }));
    try {
      await api.patch(`/members/${memberId}`, { [field]: normalised });
    } catch (err) {
      showApiError(err, "Save failed");
      // Re-load to get back to canonical server state.
      load();
      throw err;
    }
  };
  // Backwards-compat alias: the parent-mobile editor calls `patchParent`
  // with the same (id, field, value) signature.
  const patchParent = patchMember;

  const toggleAttendance = async (m) => {
    setBusyId(m.id);
    try {
      const res = await api.post(`/admin/attendance/toggle/${m.id}`, { reason: "Admin console override" });
      toast.success(res.action === "checkin" ? `${m.full_name} checked in` : `${m.full_name} checked out (${res.hours}h)`);
      load();
    } catch (err) { showApiError(err, "Failed"); }
    finally { setBusyId(null); }
  };

  return (
    <div className="p-4 md:p-8 max-w-[1600px] mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Members</h1>
          <p className="text-slate-500 text-sm mt-1">{members.length} total · click any cell to edit · double-click a row for the full form</p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/import"
            data-testid="members-import-parents"
            className="iu-btn-secondary"
            title="Upload an Excel sheet of parent / guardian contacts. Members are matched by name (spelling-tolerant)."
          >
            <FileSpreadsheet size={16}/> Import parents
          </Link>
          <button data-testid="new-member-button" onClick={() => setEditing("new")} className="iu-btn-primary"><Plus size={16}/> Add member</button>
        </div>
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
        {/* Orthogonal "Admin role" toggle. Combines with the category filter
            above — e.g. Coaches + Admins shows only coaches who are admins. */}
        <button
          data-testid="bucket-admin"
          onClick={() => setOnlyAdmins((v) => !v)}
          className={`inline-flex items-center gap-2 px-3 h-8 rounded-full text-xs font-semibold border transition ${
            onlyAdmins
              ? "bg-indigo-600 text-white border-transparent"
              : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
          }`}
          title="Filter to members with the admin role (orthogonal — combines with category)"
        >
          <ShieldCheck size={13} />
          Admin role
          <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${onlyAdmins ? "bg-white/20 text-white" : "bg-white border border-indigo-200 text-indigo-700"}`}>
            {counts.admin}
          </span>
        </button>
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
                  <th className="iu-table-th">Fleet</th>
                  <th className="iu-table-th">Last seen</th>
                  <th className="iu-table-th">Leave balance</th>
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
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-slate-900 truncate flex items-center gap-2">
                              <InlineCell
                                kind="text"
                                value={m.full_name}
                                required
                                testId={`inline-full_name-${m.id}`}
                                onSave={(v) => patchMember(m.id, "full_name", v)}
                                className="text-sm font-semibold"
                              />
                              <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
                            </div>
                            <div className="text-xs text-slate-500 truncate">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      {/* Role / category — both inline-editable. Category is
                          a select that renders the colored pill; admin role
                          is a select that renders the indigo shield badge. */}
                      <td className="iu-table-td">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <InlineCell
                            kind="select"
                            value={m.category || "athlete"}
                            options={CATEGORY_OPTS}
                            testId={`inline-category-${m.id}`}
                            onSave={(v) => patchMember(m.id, "category", v)}
                            renderDisplay={(v) => {
                              const cat = v || "athlete";
                              const meta = BUCKET_BY_KEY[cat] || BUCKET_BY_KEY.athlete;
                              return (
                                <span className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${meta.inactiveBg} ${meta.inactiveText} ${meta.inactiveBorder}`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${meta.dotBg}`} />
                                  {meta.label.replace(/s$/, "")}
                                </span>
                              );
                            }}
                          />
                          <InlineCell
                            kind="select"
                            value={m.role || "member"}
                            options={ROLE_OPTS}
                            testId={`inline-role-${m.id}`}
                            onSave={(v) => patchMember(m.id, "role", v)}
                            renderDisplay={(v) => (
                              v === "admin" ? (
                                <span
                                  data-testid={`admin-badge-${m.id}`}
                                  className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[11px] font-bold border bg-indigo-50 text-indigo-700 border-indigo-200"
                                  title="Has admin role — independent of category"
                                >
                                  <ShieldCheck size={11} /> Admin
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-semibold border bg-slate-50 text-slate-400 border-dashed border-slate-300" title="Click to grant admin">
                                  <ShieldCheck size={10} /> Member
                                </span>
                              )
                            )}
                          />
                        </div>
                        <div className="text-xs text-slate-500 mt-1">{categoryLabel(m.category)}</div>
                      </td>
                      <td className="iu-table-td text-slate-700">
                        <InlineCell
                          kind="text"
                          value={m.rank}
                          testId={`inline-rank-${m.id}`}
                          onSave={(v) => patchMember(m.id, "rank", v)}
                        />
                      </td>
                      <td className="iu-table-td text-slate-700">
                        <InlineCell
                          kind="select"
                          value={m.gender || ""}
                          options={GENDER_OPTS}
                          testId={`inline-gender-${m.id}`}
                          onSave={(v) => patchMember(m.id, "gender", v)}
                          renderDisplay={(v) => v ? GENDER_LABEL[v] : <span className="text-slate-300">—</span>}
                        />
                      </td>
                      <td className="iu-table-td text-slate-700 font-mono text-xs">
                        <InlineCell
                          kind="tel"
                          value={m.mobile}
                          testId={`inline-mobile-${m.id}`}
                          onSave={(v) => patchMember(m.id, "mobile", v)}
                          className="font-mono"
                        />
                      </td>
                      <td className="iu-table-td text-slate-700">
                        <InlineCell
                          kind="select"
                          value={m.institution || ""}
                          options={INSTITUTION_OPTS}
                          testId={`inline-institution-${m.id}`}
                          onSave={(v) => patchMember(m.id, "institution", v)}
                          renderDisplay={(v) => v || <span className="text-slate-300">—</span>}
                        />
                      </td>
                      <td className="iu-table-td text-slate-700">
                        <InlineCell
                          kind="select"
                          value={m.fleet || ""}
                          options={FLEET_OPTS}
                          testId={`inline-fleet-${m.id}`}
                          onSave={(v) => patchMember(m.id, "fleet", v)}
                          renderDisplay={(v) => v ? (
                            <span className="inline-flex items-center px-2 h-5 rounded text-[11px] font-bold bg-sky-100 text-sky-700">{v}</span>
                          ) : <span className="text-slate-300">—</span>}
                        />
                      </td>
                      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap" data-testid={`last-seen-${m.id}`}>
                        {lastSeenLabel(m.last_seen_date, today)}
                      </td>
                      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap" data-testid={`leave-balance-${m.id}`}>
                        {m.category !== "athlete" ? (
                          <InlineCell
                            kind="number"
                            value={m.leave_balance_opening}
                            testId={`inline-leave_balance_opening-${m.id}`}
                            onSave={(v) => patchMember(m.id, "leave_balance_opening", v)}
                            renderDisplay={() => leaveBalanceLabel(m)}
                          />
                        ) : leaveBalanceLabel(m)}
                      </td>
                      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap">
                        {m.work_start || "—"}{m.work_end ? <> – {m.work_end}</> : null}
                      </td>
                      <td className="iu-table-td text-slate-700 text-xs capitalize">{m.weekly_off || "—"}</td>
                      {/* Inline editable parent mobile numbers, prefixed with the
                          parent's NAME (read-only here — names are edited via
                          the row's edit modal). */}
                      <td className="iu-table-td">
                        <div className="flex flex-col gap-1 min-w-[320px] max-w-[420px]">
                          <ParentInlineInput memberId={m.id} field="father_mobile" label={m.father_name || "F"} initial={m.father_mobile} onSave={patchParent} />
                          <ParentInlineInput memberId={m.id} field="mother_mobile" label={m.mother_name || "M"} initial={m.mother_mobile} onSave={patchParent} />
                          <ParentInlineInput memberId={m.id} field="guardian_mobile" label={m.guardian_name || "G"} initial={m.guardian_mobile} onSave={patchParent} />
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
                  <tr><td colSpan={15} className="text-center py-10 text-slate-500 text-sm">No members found.</td></tr>
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
        className={`${isShortBadge ? "w-5 h-5" : "px-1.5 h-5 max-w-[200px] truncate"} rounded text-[10px] font-bold flex items-center justify-center ${labelColor}`}
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
