/**
 * Profile — a rich, data-dense "everything about me" dashboard for the
 * member. Data comes from /api/me/profile-details (see server.py).
 *
 * Sections in order (all collapsible where they have a drill-down):
 *   1. Hero (avatar + name + role)
 *   2. Top KPI strip — Present Days · Late · OT · Comp-off · Paid Leave
 *   3. Leave & Comp-off balance cards with used/available bars
 *   4. YTD attendance summary (present · absent · leave · LOP · tour)
 *   5. Late arrivals this month — expandable list, dates + minutes late
 *   6. Early outs this month — expandable list
 *   7. Recent attendance timeline
 *   8. My reasons (reason-bank cleanup panel)
 *
 * 20 Feb 2026 — user request for a data-rich profile.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Clock, Calendar, AlertCircle, Loader2, Camera, TrendingUp,
  Coffee, LogOut, ChevronDown, ChevronRight, Award, PhoneCall,
  Zap, CalendarClock, Layers, Search, X,
} from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import { useAuth } from "../auth";
import Avatar from "../components/Avatar";
import { formatTime, formatDate, categoryLabel } from "../utils";

/** Turn "78 minutes" into "1h 18m" / "0m". */
function fmtMin(m) {
  if (!m) return "0m";
  const n = Math.abs(m);
  const h = Math.floor(n / 60);
  const mm = n % 60;
  const sign = m < 0 ? "-" : "";
  if (!h) return `${sign}${mm}m`;
  return mm ? `${sign}${h}h ${mm}m` : `${sign}${h}h`;
}

export default function Profile() {
  const { user: authUser, refreshMe } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Admin-only: viewing another member's profile via ?member=<uuid>.
  // Members ignore this param entirely (RequireMember gate keeps them
  // on their own /me/profile-details anyway).
  const isAdmin = authUser?.role === "admin";
  const targetId = isAdmin ? searchParams.get("member") : null;
  const viewingOther = !!targetId && targetId !== authUser?.id;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    (async () => {
      try {
        // Admin viewing someone else → admin endpoint (returns .user).
        // Self view → the classic /me endpoint (Hero pulls from useAuth).
        const path = viewingOther
          ? `/admin/members/${targetId}/profile-details`
          : "/me/profile-details";
        const payload = await api.get(path);
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) showApiError(err, "Couldn't load profile");
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [viewingOther, targetId]);

  const displayUser = viewingOther ? (data?.user || null) : authUser;

  const handlePhotoSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error("Your photo is too big. Try retaking it or pick a smaller image (max 2 MB)."); return; }
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      await api.post("/members/me/photo", { photo: dataUrl });
      await refreshMe();
      toast.success("Profile photo updated");
    } catch (err) {
      showApiError(err, "Could not upload");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="p-3 md:p-6 max-w-5xl mx-auto space-y-4" data-testid="profile-page">
      {isAdmin && (
        <AdminMemberSearch
          selfId={authUser?.id}
          targetId={targetId}
          onPick={(id) => {
            const next = new URLSearchParams(searchParams);
            if (!id || id === authUser?.id) next.delete("member");
            else next.set("member", id);
            setSearchParams(next, { replace: true });
          }}
        />
      )}
      <ProfileHero
        user={displayUser}
        uploading={uploading}
        onSelect={handlePhotoSelected}
        readOnly={viewingOther}
      />

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : data ? (
        <>
          <KPIStrip d={data}/>
          <BalanceCards d={data}/>
          <YearOverviewCard d={data}/>
          <LateArrivalsCard rows={data.late_this_month}/>
          <EarlyOutsCard rows={data.early_outs_this_month}/>
          <RecentAttendanceCard rows={data.recent_attendance}/>
          {/* Reason bank is a personal cleanup tool — only surfaced on
              self-view (18 Feb 2026). Admins viewing another member get
              a read-only profile per user pref (2a). */}
          {!viewingOther && <MyReasonsSection/>}
        </>
      ) : null}
    </div>
  );
}

// ------------ Admin member search (18 Feb 2026 user request) -------------

/**
 * Shown at the top of Profile only for admin users. Lets an admin
 * search any member by name / category / rank and swap the profile
 * view to that person via a ?member=<uuid> URL param. Picking their
 * own row (or clearing) restores the self-view.
 */
function AdminMemberSearch({ selfId, targetId, onPick }) {
  const [members, setMembers] = useState(null); // null = not yet fetched
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Lazy-load the full member roster the first time the admin
    // clicks in. Keeps first-paint of Profile fast for the common
    // "view my own profile" case.
    if (open && members === null) {
      api.get("/members")
        .then((rows) => setMembers(Array.isArray(rows) ? rows : []))
        .catch(() => setMembers([]));
    }
  }, [open, members]);

  const currentTarget = useMemo(() => {
    if (!targetId || !members) return null;
    return members.find((m) => m.id === targetId) || null;
  }, [targetId, members]);

  const results = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    if (!q) return members.slice(0, 30);
    return members
      .filter((m) =>
        (m.full_name || "").toLowerCase().includes(q)
        || (m.category || "").toLowerCase().includes(q)
        || (m.rank || "").toLowerCase().includes(q)
        || (m.email || "").toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [members, query]);

  return (
    <div className="iu-card p-3 md:p-4" data-testid="admin-profile-search-card">
      <label className="iu-label flex items-center gap-1.5 mb-2">
        <Search size={12}/> View any member&rsquo;s profile
      </label>
      {targetId && targetId !== selfId ? (
        <div className="flex items-center gap-2">
          <span className="iu-chip iu-chip-active" data-testid="admin-profile-search-current">
            {currentTarget?.full_name || "Loading…"}
          </span>
          <button
            type="button"
            onClick={() => { onPick(null); setQuery(""); }}
            className="iu-btn-secondary !h-8 !px-2"
            data-testid="admin-profile-search-clear"
            title="Return to my own profile"
          >
            <X size={12}/> Back to my profile
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            data-testid="admin-profile-member-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 180)}
            placeholder="Search a member by name, category, rank, or email…"
            className="iu-input w-full"
          />
          {open && results.length > 0 && (
            <ul
              className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-blue-200 rounded-lg shadow-lg divide-y"
              data-testid="admin-profile-search-results"
            >
              {results.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { onPick(m.id); setQuery(""); setOpen(false); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center gap-2"
                    data-testid={`admin-profile-search-pick-${m.id}`}
                  >
                    <Avatar name={m.full_name} photo={m.photo} size={24} />
                    <span className="flex-1 truncate">
                      <b>{m.full_name}</b>
                      <span className="text-slate-400 text-xs ml-2">
                        {categoryLabel(m.category)}
                        {m.rank ? ` · ${m.rank}` : ""}
                        {m.institution ? ` · ${m.institution}` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {open && members && results.length === 0 && (
            <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow px-3 py-2 text-sm text-slate-500">
              No matches.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ------------ Hero (header) ---------------------------------------------

function ProfileHero({ user, uploading, onSelect, readOnly }) {
  return (
    <div className="iu-card p-4 md:p-5 mb-4 flex items-center gap-4" data-testid="profile-hero">
      <div className="relative shrink-0" data-testid="profile-avatar">
        <Avatar name={user?.full_name} photo={user?.photo || user?.photo_url} size={64} />
        {!readOnly && (
          <label className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center cursor-pointer shadow hover:bg-slate-800" title="Change photo">
            {uploading ? <Loader2 className="animate-spin" size={11}/> : <Camera size={11} />}
            <input
              data-testid="photo-input"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onSelect}
              disabled={uploading}
            />
          </label>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h1 className="text-lg md:text-xl font-extrabold tracking-tight truncate" data-testid="profile-name">{user?.full_name}</h1>
        <p className="text-xs text-slate-500 truncate">
          {user?.rank ? `${user.rank} · ` : ""}{categoryLabel(user?.category)} · {user?.role === "admin" ? "Admin" : "Member"}
        </p>
        <p className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
          <span className="truncate">{user?.email}</span>
          {user?.mobile && <span className="inline-flex items-center gap-1"><PhoneCall size={10}/>{user.mobile}</span>}
          {user?.institution && <span>· {user.institution}</span>}
          {user?.fleet && <span>· Fleet: {user.fleet}</span>}
        </p>
      </div>
    </div>
  );
}

// ------------ Section 2 — KPI strip -------------------------------------

function KPIStrip({ d }) {
  const balance = d.balance || {};
  const comp = d.comp_off || {};
  const attn = d.attendance || {};
  const ot = d.overtime || {};
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6" data-testid="profile-kpi">
      <KPI
        label="Days Present (MTD)"
        value={attn.days_this_month ?? 0}
        sub={`${attn.month_hours ?? 0}h logged`}
        Icon={Calendar}
        accent="emerald"
        testid="kpi-days-mtd"
      />
      <KPI
        label="Late Arrivals (MTD)"
        value={attn.late_days_this_month ?? 0}
        sub={`${attn.late_days_ytd ?? 0} YTD`}
        Icon={AlertCircle}
        accent="amber"
        testid="kpi-late-mtd"
      />
      <KPI
        label="OT (MTD)"
        value={fmtMin(ot.month_minutes)}
        sub={`${fmtMin(ot.ytd_minutes)} YTD`}
        Icon={Zap}
        accent="violet"
        testid="kpi-ot-mtd"
      />
      <KPI
        label="Comp-off Available"
        value={comp.available ?? 0}
        sub={`${comp.accrued ?? 0} earned · ${comp.used ?? 0} used`}
        Icon={Coffee}
        accent="teal"
        testid="kpi-comp-off"
      />
      <KPI
        label="Paid Leave Available"
        value={balance?.paid_leave?.available ?? 0}
        sub={`${balance?.paid_leave?.opening ?? 0} opening · ${balance?.paid_leave?.used ?? 0} used`}
        Icon={Award}
        accent="sky"
        testid="kpi-paid-leave"
      />
    </div>
  );
}

const ACCENT_BG = {
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-100",
  amber:   "bg-amber-50 text-amber-800 border-amber-100",
  violet:  "bg-violet-50 text-violet-800 border-violet-100",
  teal:    "bg-teal-50 text-teal-800 border-teal-100",
  sky:     "bg-sky-50 text-sky-800 border-sky-100",
  rose:    "bg-rose-50 text-rose-800 border-rose-100",
  slate:   "bg-slate-50 text-slate-800 border-slate-100",
};

function KPI({ label, value, sub, Icon, accent = "slate", testid }) {
  const cls = ACCENT_BG[accent] || ACCENT_BG.slate;
  return (
    <div className={`iu-card p-3 border ${cls}`} data-testid={testid}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon size={12} className="opacity-70"/>
        <div className="text-[9px] font-bold uppercase tracking-wider opacity-70">{label}</div>
      </div>
      <div className="text-xl font-extrabold tabular-nums leading-tight">{value}</div>
      {sub && <div className="text-[10px] mt-0.5 opacity-70">{sub}</div>}
    </div>
  );
}

// ------------ Section 3 — Balance cards with progress bars ---------------

function BalanceCards({ d }) {
  const balance = d.balance || {};
  const comp = d.comp_off || {};
  const paid = balance.paid_leave || {};
  const paidOpening = Number(paid.opening) || 0;
  const paidUsed = Number(paid.used) || 0;
  const paidAvail = Math.max(0, paidOpening - paidUsed);
  const paidPct = paidOpening > 0 ? Math.min(100, (paidUsed / paidOpening) * 100) : 0;

  const compAccrued = Number(comp.accrued) || 0;
  const compUsed = Number(comp.used) || 0;
  const compAvail = Math.max(0, compAccrued - compUsed);
  const compPct = compAccrued > 0 ? Math.min(100, (compUsed / compAccrued) * 100) : 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="profile-balances">
      <BalanceCard
        title="Paid Leave"
        Icon={Award}
        accent="sky"
        opening={paidOpening}
        used={paidUsed}
        available={paidAvail}
        pct={paidPct}
        pending={balance.pending_leave_days || 0}
        futureApproved={balance.future_approved_leave_days || 0}
        testid="balance-paid-leave"
      />
      <BalanceCard
        title="Comp-off"
        Icon={Coffee}
        accent="teal"
        opening={compAccrued}
        used={compUsed}
        available={compAvail}
        pct={compPct}
        breakdown={comp.breakdown || {}}
        testid="balance-comp-off"
      />
    </div>
  );
}

function BalanceCard({ title, Icon, accent, opening, used, available, pct, pending, futureApproved, breakdown, testid }) {
  return (
    <div className={`iu-card p-4 border ${ACCENT_BG[accent] || ACCENT_BG.slate}`} data-testid={testid}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className="opacity-80"/>
        <div className="font-extrabold tracking-tight text-sm">{title}</div>
        <div className="ml-auto text-[10px] opacity-70">{opening} total</div>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <MiniStat label="Used" value={used}/>
        <MiniStat label="Available" value={available} bold/>
        <MiniStat label="Total" value={opening}/>
      </div>
      <div className="h-1.5 bg-white/50 rounded-full overflow-hidden mb-2">
        <div className={`h-full ${accent === "sky" ? "bg-sky-500" : "bg-teal-500"} transition-all`} style={{ width: `${pct}%` }}/>
      </div>
      <div className="text-[10px] opacity-70 flex flex-wrap gap-x-3">
        {pending !== undefined && <span>Pending: <b>{pending}d</b></span>}
        {futureApproved !== undefined && <span>Future approved: <b>{futureApproved}d</b></span>}
        {breakdown?.weekly_off !== undefined && <span>Weekly-off worked: <b>{breakdown.weekly_off}d</b></span>}
        {breakdown?.holiday !== undefined && <span>Holiday worked: <b>{breakdown.holiday}d</b></span>}
      </div>
    </div>
  );
}

function MiniStat({ label, value, bold }) {
  return (
    <div>
      <div className={`tabular-nums ${bold ? "text-xl font-extrabold" : "text-lg font-bold"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider opacity-60 font-semibold">{label}</div>
    </div>
  );
}

// ------------ Section 4 — Year overview (attendance ledger) --------------

function YearOverviewCard({ d }) {
  const b = d.balance || {};
  const attn = d.attendance || {};
  const cells = [
    { label: "Present YTD",   value: attn.days_ytd ?? 0,             tone: "emerald" },
    { label: "Absent YTD",    value: b.absent_ytd_days ?? 0,          tone: "rose" },
    { label: "Tour YTD",      value: b.tour_ytd_days ?? 0,            tone: "orange" },
    { label: "LOP YTD",       value: b.lop_ytd_days ?? 0,             tone: "rose" },
    { label: "Hours YTD",     value: `${attn.ytd_hours ?? 0}h`,        tone: "slate" },
    { label: "Late YTD",      value: attn.late_days_ytd ?? 0,          tone: "amber" },
  ];
  return (
    <div className="iu-card p-4" data-testid="profile-ytd">
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={14} className="text-slate-500"/>
        <h2 className="font-extrabold tracking-tight text-sm">Year-to-Date Overview</h2>
      </div>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {cells.map((c) => (
          <div key={c.label} className={`p-2 rounded-lg border ${ACCENT_BG[c.tone] || ACCENT_BG.slate}`}>
            <div className="text-lg font-extrabold tabular-nums leading-tight">{c.value}</div>
            <div className="text-[9px] uppercase tracking-wider mt-0.5 opacity-70 font-semibold">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------ Section 5 — Late arrivals list -----------------------------

function CollapsibleList({ title, Icon, count, empty, testid, children }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="iu-card overflow-hidden" data-testid={testid}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-slate-50 transition-colors text-left"
        aria-expanded={open}
      >
        <Icon size={14} className="text-slate-500"/>
        <h3 className="font-extrabold tracking-tight flex-1 text-sm">{title}</h3>
        <span className="inline-flex items-center justify-center min-w-[28px] h-6 px-2 rounded-full bg-slate-100 text-slate-700 text-xs font-bold tabular-nums">
          {count}
        </span>
        {open ? <ChevronDown size={16} className="text-slate-400"/> : <ChevronRight size={16} className="text-slate-400"/>}
      </button>
      {open && (
        count === 0
          ? <div className="px-5 py-6 text-center text-slate-400 text-sm italic">{empty}</div>
          : <div className="border-t border-slate-100">{children}</div>
      )}
    </section>
  );
}

function LateArrivalsCard({ rows }) {
  return (
    <CollapsibleList
      title="Late Arrivals — This Month"
      Icon={CalendarClock}
      count={rows?.length || 0}
      empty="On time every day this month 🎉"
      testid="profile-late-arrivals"
    >
      <ul className="divide-y divide-slate-100">
        {(rows || []).map((r) => (
          <li key={r.id || r.date} className="px-5 py-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center text-amber-700"><AlertCircle size={16}/></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{formatDate(r.date)}</div>
              <div className="text-xs text-slate-500">
                Checked in at {formatTime(r.check_in_at)}
                {r.hours != null && <> · {r.hours}h worked</>}
              </div>
            </div>
            <div className="text-sm font-bold text-amber-700 tabular-nums">+{r.late_minutes}m</div>
          </li>
        ))}
      </ul>
    </CollapsibleList>
  );
}

// ------------ Section 6 — Early outs list --------------------------------

function EarlyOutsCard({ rows }) {
  return (
    <CollapsibleList
      title="Early Outs — This Month"
      Icon={LogOut}
      count={rows?.length || 0}
      empty="No early departures this month."
      testid="profile-early-outs"
    >
      <ul className="divide-y divide-slate-100">
        {(rows || []).map((r) => (
          <li key={r.id || r.date} className="px-5 py-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-rose-100 flex items-center justify-center text-rose-700"><LogOut size={16}/></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm">{formatDate(r.date)}</div>
              <div className="text-xs text-slate-500">
                Out at {formatTime(r.check_out_at)} (expected {r.expected_end})
                {r.hours != null && <> · {r.hours}h worked</>}
              </div>
              {r.reason ? (
                <div className="text-[11px] text-rose-700 mt-0.5 italic truncate" title={r.reason} data-testid={`early-out-reason-${r.id}`}>
                  &ldquo;{r.reason}&rdquo;
                </div>
              ) : null}
            </div>
            <div className="text-sm font-bold text-rose-700 tabular-nums">−{r.early_by_minutes}m</div>
          </li>
        ))}
      </ul>
    </CollapsibleList>
  );
}

// ------------ Section 7 — Recent attendance timeline ---------------------

function RecentAttendanceCard({ rows }) {
  return (
    <section className="iu-card" data-testid="profile-recent">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center gap-2">
        <Layers size={14} className="text-slate-500"/>
        <h2 className="font-extrabold tracking-tight text-sm">Recent Attendance</h2>
        <span className="ml-auto text-[11px] text-slate-400">Last {rows?.length || 0} sessions</span>
      </div>
      {(rows || []).length === 0 ? (
        <div className="p-8 text-center text-slate-500 text-sm">No attendance logged yet.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((s) => (
            <li key={s.id} className="px-5 py-3 flex items-center gap-3" data-testid={`recent-${s.id}`}>
              <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-700"><Clock size={16}/></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">{formatDate(s.date)}</div>
                <div className="text-xs text-slate-500 flex flex-wrap gap-x-2">
                  <span>{formatTime(s.check_in_at)} – {s.check_out_at ? formatTime(s.check_out_at) : "Open"}</span>
                  {s.late ? <span className="text-amber-700 font-semibold">· Late {s.late_minutes}m</span> : null}
                  {s.overtime_total_min ? <span className="text-violet-700 font-semibold">· OT {fmtMin(s.overtime_total_min)}</span> : null}
                </div>
              </div>
              <div className="text-sm font-bold text-slate-900 tabular-nums">
                {s.hours ?? "—"}{typeof s.hours === "number" ? "h" : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------ Section 8 — Reason bank cleanup ---------------------------

function MyReasonsSection() {
  const [reasons, setReasons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    (async () => {
      try { setReasons((await api.get("/me/reasons"))?.reasons || []); }
      finally { setLoading(false); }
    })();
  }, []);

  const remove = async (reason) => {
    setBusy(reason);
    try {
      const res = await api.del(`/me/reasons?reason=${encodeURIComponent(reason)}`);
      setReasons(res?.reasons || []);
    } catch (err) {
      showApiError(err, "Could not remove");
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return (
      <section className="iu-card p-5 mt-6" data-testid="my-reasons-section">
        <h3 className="font-extrabold tracking-tight mb-1 text-sm text-slate-500 uppercase">My Reasons</h3>
        <div className="text-xs text-slate-400 flex items-center gap-1.5"><Loader2 className="animate-spin" size={11}/> loading…</div>
      </section>
    );
  }

  return (
    <section className="iu-card p-5 mt-6" data-testid="my-reasons-section">
      <h3 className="font-extrabold tracking-tight mb-1 text-sm text-slate-500 uppercase">My Reasons</h3>
      <p className="text-xs text-slate-500 mb-3">
        Reasons you&apos;ve typed on overtime check-ins and comp-off applications. They&apos;ll re-appear as suggestions next time.
      </p>
      {reasons.length === 0 ? (
        <p className="text-xs text-slate-400 italic">Nothing here yet — reasons show up automatically the first time you use them.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" data-testid="my-reasons-list">
          {reasons.map((r) => (
            <li key={r} className="inline-flex items-center gap-1 border border-slate-300 rounded-full px-2 py-0.5 bg-white text-[11px] font-medium text-slate-700">
              <span>{r}</span>
              <button
                type="button"
                onClick={() => remove(r)}
                disabled={busy === r}
                data-testid="my-reasons-remove"
                aria-label={`Remove ${r}`}
                className="ml-0.5 text-slate-400 hover:text-red-600 disabled:opacity-40"
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
