import React, { useCallback, useEffect, useState, useMemo } from "react";
import { Loader2, Plus, Search, FileSpreadsheet } from "lucide-react";
import { toast } from "sonner";
import { Link, useSearchParams } from "react-router-dom";
import { api, showApiError } from "../../api";
import CorrectionRequestModal from "../../components/CorrectionRequestModal";
import MemberForm from "./MemberForm";
import MemberBucketFilters from "./members/MemberBucketFilters";
import MemberRow from "./members/MemberRow";
import SortableTh, { COL_HELP } from "./members/SortableTh";
import { bucketOf } from "./members/helpers";
import ExMemberToggle, { useExMemberToggle } from "../../components/ExMemberToggle";
import { filterEx, isExMember } from "../../utils/exMember";

/**
 * Members admin page — table view with inline editing, bulk-edit toolbar,
 * orthogonal Admin-role filter, institution filter, and "Force check-in/out"
 * shortcut per row.
 *
 * The big row template and the bucket-filter chip row have been extracted
 * to `members/MemberRow.jsx` and `members/MemberBucketFilters.jsx`. Helper
 * functions + constants live in `members/helpers.js`. This file now owns
 * data-fetch + mutation state only.
 */
export default function Members() {
  const [members, setMembers] = useState([]);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // member object or "new"
  // Admin-filed correction target — when set, opens the correction
  // modal pre-scoped to that member. Cleared on close/save.
  const [correctingFor, setCorrectingFor] = useState(null);
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [bucket, setBucket] = useState("all");
  // Orthogonal "Admin role" filter. Independent of `bucket` because admin is
  // a ROLE, not a category — a coach who is also an admin is BOTH a coach
  // and an admin and should appear under either filter.
  const [onlyAdmins, setOnlyAdmins] = useState(false);
  // Same orthogonal treatment for chefs (kitchen crew who log meal purchases
  // & issues). Requested Feb 2026.
  const [onlyChefs, setOnlyChefs] = useState(false);
  const [instFilter, setInstFilter] = useState("");
  const [institutions, setInstitutions] = useState([]);
  // Ex-member visibility toggle — default OFF (hide members who have
  // exited). Toggle persists per-page via localStorage so an admin can
  // pin their preference. 24 Feb 2026.
  const [showEx, setShowEx] = useExMemberToggle("members");
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
    { value: "elite",     label: "Elite" },
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
  // Bundle for MemberRow — passing as one prop keeps the row component's
  // signature tidy and avoids one prop-update per option list change.
  const rowOptions = useMemo(
    () => ({ CATEGORY_OPTS, ROLE_OPTS, GENDER_OPTS, FLEET_OPTS, INSTITUTION_OPTS, WEEKLY_OFF_OPTS }),
    [CATEGORY_OPTS, ROLE_OPTS, GENDER_OPTS, FLEET_OPTS, INSTITUTION_OPTS, WEEKLY_OFF_OPTS],
  );

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
    // Pill counts are STABLE — each shows the total for that bucket
    // or role across the (non-ex) roster, independent of every other
    // filter. Users read the counts as "table of contents": always
    // there, never shrinking. Only the row list narrows on click.
    // (Previous "faceted counts" iteration confused admins into
    // thinking the roster itself had shrunk — Feb 2026 rewrite.)
    // Feb 2026 · UX rework — every pill count is now STABLE: it
    // reflects the total in that bucket / role across the roster,
    // ignoring the currently-active pills. Users found the earlier
    // "faceted counts" (Coach shows how many coaches remain if you
    // click Chef) confusing — they read the pill numbers as the
    // roster shrinking. Stable counts make the pills act like a
    // table of contents: always visible, always the same, and only
    // the row list narrows on click.
    const active = filterEx(members, showEx);
    const c = { all: active.length, coach: 0, staff: 0, executive: 0, athlete: 0, elite: 0 };
    let adminCount = 0;
    let chefCount = 0;
    for (const m of active) {
      const b = bucketOf(m);
      if (c[b] !== undefined) c[b] += 1;
      if (m.role === "admin") adminCount += 1;
      if (m.role === "chef") chefCount += 1;
    }
    c.admin = adminCount;
    c.chef = chefCount;
    return c;
  }, [members, showEx]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = filterEx(members, showEx);
    if (bucket !== "all") list = list.filter((m) => bucketOf(m) === bucket);
    // Role toggles OR-combine — a member with EITHER selected role
    // shows. AND-combining was the review's Low finding: enabling both
    // yields an empty list since no member is both admin AND chef.
    if (onlyAdmins || onlyChefs) {
      const wantAdmin = onlyAdmins;
      const wantChef = onlyChefs;
      list = list.filter((m) => (wantAdmin && m.role === "admin") || (wantChef && m.role === "chef"));
    }
    if (instFilter) list = list.filter((m) => m.institution === instFilter);
    if (!q) return list;
    return list.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.email || "").toLowerCase().includes(q) ||
      (m.rank || "").toLowerCase().includes(q) ||
      (m.mobile || "").includes(q) ||
      (m.institution || "").toLowerCase().includes(q)
    );
  }, [members, showEx, search, bucket, onlyAdmins, onlyChefs, instFilter]);

  const exCount = useMemo(() => members.filter((m) => isExMember(m)).length, [members]);

  // Any filter beyond the defaults?  Search box + admin/chef/institution
  // toggles + bucket. Used to show/hide the "Clear filters" reset button.
  const anyFilterOn = bucket !== "all" || onlyAdmins || onlyChefs || !!instFilter || !!search.trim();
  const clearFilters = () => {
    setBucket("all");
    setOnlyAdmins(false);
    setOnlyChefs(false);
    setInstFilter("");
    setSearch("");
  };

  // ── Column sort ───────────────────────────────────────────────────────────
  // Click a sortable header to cycle: unsorted → asc → desc → unsorted.
  // Sort direction preserves natural handling per column type: strings use
  // locale-aware compare, numbers numeric compare, dates ISO compare (which
  // is lexical == chronological for YYYY-MM-DD), booleans true>false.
  // "Last seen" sorts by the underlying `last_seen_date` (most-recent first
  // means desc); rows with no value sink to the bottom regardless of dir.
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState(null); // "asc" | "desc" | null
  const toggleSort = useCallback((key) => {
    // Cycle: different key → asc · same key asc → desc · same key desc → clear
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else if (sortDir === "desc") {
      setSortKey(null);
      setSortDir(null);
    } else {
      setSortDir("asc");
    }
  }, [sortKey, sortDir]);
  const sortedFiltered = useMemo(() => {
    if (!sortKey || !sortDir) return filtered;
    const arr = [...filtered];
    const dir = sortDir === "asc" ? 1 : -1;
    // Push blanks to the bottom regardless of direction.
    const blank = (v) => v == null || v === "";
    const cmp = (a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      if (blank(va) && blank(vb)) return 0;
      if (blank(va)) return 1;
      if (blank(vb)) return -1;
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      if (typeof va === "boolean" && typeof vb === "boolean") return (Number(vb) - Number(va)) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" }) * dir;
    };
    arr.sort(cmp);
    return arr;
  }, [filtered, sortKey, sortDir]);

  // Deep-link handling — Data Quality "Fix" buttons route here with
  // `?edit=<id>` (opens the edit modal directly) or `?highlight=<id>`
  // (scrolls the row into view and briefly tints it amber). Both
  // params are consumed once; we strip them so a refresh doesn't
  // re-open the modal.
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get("highlight");
  const editId = searchParams.get("edit");
  useEffect(() => {
    if (!editId || loading || members.length === 0) return;
    const m = members.find((x) => x.id === editId);
    if (m) setEditing(m);
    // Consume the param so a refresh doesn't re-pop the modal.
    setSearchParams((p) => {
      const np = new URLSearchParams(p);
      np.delete("edit");
      return np;
    }, { replace: true });
  }, [editId, members, loading, setSearchParams]);

  // Highlight-scroll: when the deep-link points at a member, scroll
  // their row into view once the members list is loaded so admins
  // land visually on the record they came here to fix.
  useEffect(() => {
    if (!highlightId || loading) return;
    const el = document.querySelector(`[data-testid="member-row-${highlightId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightId, loading, sortedFiltered]);

  const remove = useCallback(async (m) => {
    if (!window.confirm(`Delete ${m.full_name}? This also removes their attendance & leaves.`)) return;
    try {
      await api.del(`/members/${m.id}`);
      toast.success("Member deleted");
      load();
    } catch (err) { showApiError(err, "Failed"); }
  }, [load]);

  // Inline patch — apply update locally first (optimistic) + persist to API,
  // without triggering a full reload (which would interrupt other open
  // inputs). Used by both the parent-mobile cells and the new InlineCell
  // editors for name/category/role/rank/mobile/gender/fleet/leave-balance.
  const patchMember = useCallback(async (memberId, field, value) => {
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
  }, [load]);

  // ── Multi-selection removed 20 Feb 2026 ──────────────────────────────────
  // The bulk-select checkbox column and floating BulkEditBar were removed
  // because inline cell-editing + fleet/institution search covers the same
  // need without the visual clutter (chef felt the checkboxes distracted
  // from the members data). If bulk edits are ever needed again, restore
  // this section along with the header <th> checkbox and BulkEditBar render.

  const toggleAttendance = useCallback(async (m) => {
    setBusyId(m.id);
    try {
      const res = await api.post(`/admin/attendance/toggle/${m.id}`, { reason: "Admin console override" });
      toast.success(res.action === "checkin" ? `${m.full_name} checked in` : `${m.full_name} checked out (${res.hours}h)`);
      load();
    } catch (err) { showApiError(err, "Failed"); }
    finally { setBusyId(null); }
  }, [load]);

  // Photo-saved callback wired into each row's InlinePhotoAvatar.
  // Optimistically merges the new photo into local state so the avatar
  // updates without a full reload (load() runs anyway on edit-modal close).
  const onPhotoUpdated = (memberId) => (u) =>
    setMembers((prev) => prev.map((x) => (x.id === memberId ? { ...x, photo: u.photo } : x)));

  return (
    <div className="p-4 md:p-8 max-w-[1600px] mx-auto pb-24">
      {/* `pb-24` bottom padding leaves room for the sticky BulkEditBar so
          the last table row isn't hidden behind it when ≥1 row is selected. */}
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Members</h1>
          <p className="text-slate-500 text-sm mt-1">
            <b>{filtered.length}</b> shown
            <span className="text-slate-400"> / {members.length} total</span>
            <span> · click any cell to edit · double-click a row for the full form</span>
          </p>
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
          <button data-testid="new-member-button" onClick={() => setEditing("new")} title="Create a new athlete, coach, staff or chef profile" className="iu-btn-primary"><Plus size={16}/> Add member</button>
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

      <MemberBucketFilters
        bucket={bucket}
        // Feb 2026 · UX fix — clicking ALL now clears the orthogonal
        // Admin/Chef/Institution filters in addition to the bucket, so
        // "All" actually means "show me every active member" (matching
        // the count on the pill). Choosing any other bucket keeps the
        // role toggles because those are legitimate intersections
        // (e.g. Coaches AND admins).
        onBucketChange={(next) => {
          setBucket(next);
          if (next === "all") {
            setOnlyAdmins(false);
            setOnlyChefs(false);
            setInstFilter("");
          }
        }}
        counts={counts}
        onlyAdmins={onlyAdmins}
        onAdminToggle={() => setOnlyAdmins((v) => !v)}
        onlyChefs={onlyChefs}
        onChefToggle={() => setOnlyChefs((v) => !v)}
        institutions={institutions}
        instFilter={instFilter}
        onInstFilterChange={setInstFilter}
        anyFilterOn={anyFilterOn}
        onClearFilters={clearFilters}
      />

      <div className="flex items-center gap-2 mb-2">
        <ExMemberToggle showEx={showEx} onChange={setShowEx} exCount={exCount} />
        <span className="text-[11px] text-slate-400">
          {exCount === 0
            ? "No ex-members on file."
            : showEx
              ? `Showing all members including ${exCount} who have left.`
              : `${exCount} ex-member${exCount === 1 ? "" : "s"} hidden — click to include.`}
        </span>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-auto max-h-[75vh]">
            <table className="w-full text-sm iu-table-compact"><thead className="bg-slate-50 sticky top-0 z-20">
                <tr>
                  <th className="iu-table-th w-16 text-center sticky left-0 z-30 bg-slate-50 !text-slate-700 !font-bold" title={COL_HELP.edit}>Edit</th>
                  <SortableTh k="full_name" className="sticky left-16 z-30 bg-slate-50 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Member</SortableTh>
                  <SortableTh k="ot_eligible" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="center">OT / Meal</SortableTh>
                  <SortableTh k="category" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Category</SortableTh>
                  <SortableTh k="role" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Role</SortableTh>
                  <SortableTh k="rank" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Rank</SortableTh>
                  <SortableTh k="gender" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Gender</SortableTh>
                  <SortableTh k="mobile" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Mobile</SortableTh>
                  <SortableTh k="institution" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Institution</SortableTh>
                  <SortableTh k="fleet" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Fleet</SortableTh>
                  <SortableTh k="last_seen_date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Last seen</SortableTh>
                  <SortableTh k="leave_balance_opening" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Leave balance</SortableTh>
                  <SortableTh k="work_start" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Hours</SortableTh>
                  <SortableTh k="weekly_off" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>Weekly off</SortableTh>
                  <SortableTh k="date_of_birth" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort}>DOB</SortableTh>
                  <th className="iu-table-th !text-slate-700 !font-bold" title={COL_HELP.parents}>Parents / Guardian</th>
                  <th className="iu-table-th !text-slate-700 !font-bold" title={COL_HELP.status}>Status</th>
                  <th className="iu-table-th text-center w-12 !text-slate-700 !font-bold" title={COL_HELP.del}>Del</th>
                </tr>
              </thead>
              <tbody data-testid="members-table">
                {sortedFiltered.map((m, rowIdx) => (
                  <MemberRow
                    key={m.id}
                    m={m}
                    rowIdx={rowIdx}
                    today={today}
                    presenceRow={presence[m.id]}
                    busyId={busyId}
                    options={rowOptions}
                    onEdit={setEditing}
                    onDelete={remove}
                    onToggleAttendance={toggleAttendance}
                    onPatchField={patchMember}
                    onPhotoUpdated={onPhotoUpdated(m.id)}
                    onFileCorrection={setCorrectingFor}
                    highlighted={highlightId === m.id}
                  />
                ))}
                {sortedFiltered.length === 0 && (
                  <tr><td colSpan={17} className="text-center py-10 text-slate-500 text-sm">No members found.</td></tr>
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

      {correctingFor && (
        <CorrectionRequestModal
          open={true}
          onClose={() => setCorrectingFor(null)}
          onSaved={() => setCorrectingFor(null)}
          onBehalfOfMember={correctingFor}
        />
      )}
    </div>
  );
}

/**
 * Descriptions shown as native title tooltips on hover. Kept as a flat
 * lookup here so we can label BOTH sortable columns (via SortableTh) and
 * the few non-sortable ones (Edit / Parents / Status / Del) from a single
 * source of truth.
 */
// ----- SortableTh + COL_HELP moved to ./members/SortableTh.jsx -----
