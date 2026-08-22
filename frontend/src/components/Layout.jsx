import React, { useState } from "react";
import { NavLink, Outlet, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import {
  Users, LayoutDashboard, FileBarChart2, ScanLine, UserCog,
  CalendarCheck2, Building2, IdCard, Sailboat,
  LogOut, Menu, ClipboardCheck, CalendarDays, Settings, MessageSquare, Database, Sparkles, UserCheck, Camera,
  ShieldAlert, Gauge, ChefHat, PencilRuler, KeyRound, ChevronDown, ChevronRight, Utensils, PieChart, CalendarRange
} from "lucide-react";
import Avatar from "./Avatar";
import StaleSessionPrompt from "./StaleSessionPrompt";
import InstallPrompt from "./InstallPrompt";
import OfflineBanner from "./OfflineBanner";
import HelpChat from "./HelpChat";
import UserCredsChip from "./UserCredsChip";
import { api } from "../api";
import { useUiPrefs } from "../hooks/useUiPrefs";
import { useApiQuery } from "../hooks/useApiQuery";
import { useEscape } from "../hooks/useEscape";
import { useQueryClient } from "@tanstack/react-query";

/** Map: route path → [reactQueryKey to prefetch, api-path, params].
 * When the admin hovers a sidebar link we start the fetch during the
 * ~300 ms hover-to-click window so the destination page opens
 * instantly. Only routes whose data is expensive-to-compute are
 * listed — cheap pages don't benefit and would just add background
 * network churn. Added 20 Feb 2026 (perf combo item B). */
const PREFETCH_MAP = {
  "/admin/dashboard":   ["/admin/dashboard", null],
  "/admin/approvals":   ["/leaves", null],
  "/admin/members":     ["/members", null],
};

const NAV_MEMBER = [
  { to: "/", label: "My Check In/Out", icon: ScanLine, end: true, hint: "Check yourself in or out with a selfie and location" },
  { to: "/my-leaves", label: "Leave/Tour/Late", icon: CalendarCheck2, hint: "Apply for leave, tour or late arrival and track approvals" },
  // Correction requests raised by the member (missed check-ins, wrong
  // times, leave changes). Badge count = personal pending corrections,
  // fetched from `/api/me/corrections?status=pending` in the polling
  // loop below (8 Jul 2026 user request "bring all correction requests
  // by a member under member in the main menu").
  { to: "/my-corrections", label: "My Corrections", icon: PencilRuler, badgeKey: "my_corrections", hint: "Request fixes for missed or wrong check-ins and see their status" },
  // Escort kiosk: visible to every signed-in user. Athletes/coaches/staff
  // help mark escorts in/out — escorts themselves land here after phone
  // login (auth.jsx forces the redirect when `is_escort=true`).
  { to: "/escort-checkin", label: "Escorts Check in/Out", icon: UserCheck, hint: "Mark escorts (parents/guardians) in and out of campus" },
  { to: "/profile", label: "My Profile", icon: UserCog, hint: "Your photo, contact details and login settings" },
];

// Coach live surfaces (kept for backwards-compat with existing role
// checks; the sections below actually render into the new
// Attendance / Kitchen split — see the sidebar body).
const NAV_COACH_ATTENDANCE = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
];
const NAV_COACH_KITCHEN = [
  { to: "/meals", label: "Meals Muster", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-calendar", label: "Meals Calendar", icon: CalendarRange, hint: "Daily headcount log — Breakfast / Lunch / Dinner totals per day" },
  { to: "/admin/meals-report", label: "Pantry Stock", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, consumption, wastage and stock" },
  { to: "/admin/meals-report?tab=analytics", label: "Kitchen Analytics", icon: PieChart, hint: "Purchase & consumption graphics — trends, top items, category share" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
];

// ATTENDANCE system — one visually-cohesive group for every
// attendance-related screen (live ops + masters). Aug 2026 reorg so
// the "two systems" (Attendance vs Kitchen) are obvious at a glance.
const NAV_ATTENDANCE_LIVE = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
  { to: "/admin/calendar", label: "Calendar", icon: CalendarDays, hint: "Holidays, weekly offs, camps and regattas at a glance", adminOnly: true },
  { to: "/admin/dashboard", label: "Dashboard", icon: Gauge, end: true, hint: "Single-glance summary: on campus, on leave, alerts", adminOnly: true },
  { to: "/admin/approvals", label: "Approvals", icon: ClipboardCheck, highlight: true, badgeKey: "approvals_page", hint: "Pending leaves, corrections and check-in approvals in one queue", adminOnly: true },
  { to: "/admin/reports", label: "The Grid", icon: FileBarChart2, hint: "All-in-one 31-day attendance grid with drill-downs and exports", adminOnly: true },
  { to: "/admin/devices", label: "Access Requests", icon: IdCard, hint: "Approve or block new phones/devices requesting access", adminOnly: true },
  { to: "/admin/leave-balances", label: "Leave Balances", icon: CalendarCheck2, hint: "Paid leave, comp-off and tour balances for every member", adminOnly: true },
];

const NAV_ATTENDANCE_MASTERS = [
  { to: "/admin/members", label: "Manage Members", icon: Users, hint: "Add, edit and organise athletes, staff and coaches" },
  { to: "/admin/institutions", label: "Institutions", icon: Building2, hint: "Schools/colleges members belong to" },
  { to: "/admin/fleets", label: "Fleets", icon: Sailboat, hint: "Boat fleets and class groupings" },
  { to: "/admin/categories", label: "Categories", icon: ShieldAlert, hint: "Member categories and their attendance rules" },
  { to: "/admin/roles", label: "Roles", icon: KeyRound, hint: "Who can see and do what in the app" },
];

// KITCHEN system — meals, pantry stock, chef's view, vendors. Kept
// visually distinct with an amber accent (matches the pantry warm-
// yellow banding on the Daily-entry grid).
const NAV_KITCHEN = [
  { to: "/meals", label: "Meals Muster", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-calendar", label: "Meals Calendar", icon: CalendarRange, hint: "Daily headcount log — Breakfast / Lunch / Dinner totals per day" },
  { to: "/admin/meals-report", label: "Pantry Stock", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, consumption, wastage and stock" },
  { to: "/admin/meals-report?tab=analytics", label: "Kitchen Analytics", icon: PieChart, hint: "Purchase & consumption graphics — trends, top items, category share" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
];

// SYSTEM section — configuration, diagnostics, and safety nets.
// Training Locations moved into Office Settings (04 Feb 2026); the
// /admin/sites route still works but is reached via a card inside the
// Office Settings page, not the sidebar.
const NAV_SYSTEM = [
  { to: "/admin/office", label: "Office Settings", icon: Settings, hint: "Working hours, geofence, training locations and app configuration" },
  { to: "/admin/data-quality", label: "Data Quality", icon: ShieldAlert, hint: "Automatic checks that flag suspicious or missing data" },
  { to: "/admin/category-health", label: "Category Health", icon: ShieldAlert, hint: "Members whose category setup looks wrong" },
  { to: "/admin/sms-log", label: "SMS Log", icon: MessageSquare, hint: "Every OTP and SMS the app has sent" },
  { to: "/admin/escort-photos", label: "Escort Photo Cleanup", icon: Camera, hint: "Review and purge old escort check-in photos" },
  { to: "/admin/audit-log", label: "Audit Log", icon: ScanLine, hint: "Who changed what, when — full history" },
  { to: "/admin/backup", label: "Backup & Restore", icon: Database, hint: "Download backups or restore data" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  useEscape(open ? () => setOpen(false) : null);
  const isAdmin = user?.role === "admin";
  const isChef = user?.role === "chef";
  const canMuster = isAdmin || user?.category === "coach" || isChef;
  // Escort sessions get a stripped-down sidebar — only the kiosk link,
  // Muster Roll (institution-scoped server-side), and Sign out. They have
  // no member/coach/admin permissions otherwise.
  const isEscort = !!user?.is_escort;

  // Hover-prefetch helper. Fires a background React Query fetch when
  // the admin hovers a sidebar link (with a 200 ms debounce to avoid
  // spamming Mongo when they mouse across the entire nav). No-op if
  // the target page isn't in PREFETCH_MAP or if the query is already
  // cached and fresh.
  const queryClient = useQueryClient();
  const prefetchFor = React.useCallback((to) => {
    const spec = PREFETCH_MAP[to];
    if (!spec) return undefined;
    const [path, params] = spec;
    return () => {
      queryClient.prefetchQuery({
        queryKey: [path, params],
        queryFn: () => api.get(path, params),
        staleTime: 30_000,
      }).catch(() => {
        // Prefetch failures are silent by design — the real request
        // when the user actually navigates will surface the error.
      });
    };
  }, [queryClient]);

  // Pending-approvals badge — cached via React Query, refreshed every
  // 60 s while the tab is visible. If the fetch fails, the previous
  // count stays put (quiet-fail) so a transient backend hiccup doesn't
  // clog the sidebar with error toasts.
  const approvalsSummaryQuery = useApiQuery(
    "/admin/approvals-summary", null,
    {
      enabled: !!isAdmin && !isEscort,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    },
  );
  const approvalsSummary = approvalsSummaryQuery.data || null;

  // Collapsible sidebar sections (04 Feb 2026). Backed by useUiPrefs
  // so an admin's collapse choice syncs across devices — laptop and
  // phone remember which sections they hide. Falls back to
  // localStorage-only when offline / unauthenticated.
  const [uiPrefs, patchUiPrefs] = useUiPrefs({ sidebar_collapsed: [] });
  const collapsed = React.useMemo(
    () => new Set(uiPrefs.sidebar_collapsed || []),
    [uiPrefs.sidebar_collapsed],
  );
  const toggleSection = React.useCallback((key) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key); else next.add(key);
    patchUiPrefs({ sidebar_collapsed: [...next] });
  }, [collapsed, patchUiPrefs]);
  const isOpen = (key) => !collapsed.has(key);

  // Member-side pending-corrections badge — same 60 s cadence as the
  // admin summary via React Query.
  const myCorrectionsQuery = useApiQuery(
    "/me/corrections", { status: "pending" },
    {
      enabled: !isEscort,
      staleTime: 30_000,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    },
  );
  const myPendingCorrections = Array.isArray(myCorrectionsQuery.data)
    ? myCorrectionsQuery.data.length
    : 0;

  const memberNav = isEscort
    ? [
        ...NAV_MEMBER.filter((n) => n.to === "/escort-checkin"),
        { to: "/muster", label: "Muster Roll", icon: ClipboardCheck },
      ]
    : NAV_MEMBER;

  // Lock body scroll while the mobile drawer is open so the page underneath
  // doesn't scroll behind the overlay (fixes a "scroll bleed" on iOS Safari).
  React.useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  const handleLogout = () => {
    logout();
    nav("/login");
  };

  const sidebar = (
    <aside className="w-64 shrink-0 bg-slate-900 text-slate-100 flex flex-col h-screen" data-testid="app-sidebar">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-slate-800">
        <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center overflow-hidden">
          <img src="/favicon.png" alt="YCH" className="w-8 h-8 object-contain" />
        </div>
        <div>
          <div className="font-extrabold tracking-tight text-[15px] leading-none">Yacht Club</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 mt-1">of Hyderabad</div>
        </div>
      </div>

      <nav className="px-3 py-3 flex-1 overflow-y-auto">
        <div className="text-[13px] font-black uppercase tracking-widest text-cyan-300 px-3 py-1.5 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]">Member</div>
        {memberNav.map((item) => {
          // Member section's only badged item today is My Corrections.
          const badge = item.badgeKey === "my_corrections"
            ? (myPendingCorrections > 0 ? myPendingCorrections : undefined)
            : undefined;
          return (
            <NavItem key={item.to} {...item} badge={badge} onClick={() => setOpen(false)} />
          );
        })}
        {!isEscort && (canMuster || isChef) && !isAdmin && (
          <>
            {/* Non-admin coach / chef — get the trimmed attendance + kitchen
                lists tuned to their role. Admins see the full split
                below (with masters). */}
            {(!isChef && NAV_COACH_ATTENDANCE.length > 0) && (
              <SystemGroup label="Attendance" tone="cyan" icon={ClipboardCheck}
                           count={NAV_COACH_ATTENDANCE.length}
                           open={isOpen("attendance")} onToggle={() => toggleSection("attendance")}>
                {NAV_COACH_ATTENDANCE.map((item) => (
                  <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
                ))}
              </SystemGroup>
            )}
            <SystemGroup label="Kitchen" tone="amber" icon={ChefHat}
                         count={NAV_COACH_KITCHEN.length}
                         open={isOpen("kitchen")} onToggle={() => toggleSection("kitchen")}>
              {NAV_COACH_KITCHEN.map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
            </SystemGroup>
          </>
        )}
        {!isEscort && isAdmin && (
          <>
            <SystemGroup label="Attendance" tone="cyan" icon={ClipboardCheck}
                         count={NAV_ATTENDANCE_LIVE.length + NAV_ATTENDANCE_MASTERS.length}
                         open={isOpen("attendance")} onToggle={() => toggleSection("attendance")}>
              {NAV_ATTENDANCE_LIVE.map((item) => {
                // Synthetic key `approvals_page` sums only the queues that the
                // Approvals page actually surfaces (leaves + overtime + checkins
                // + corrections). Device approvals live on their own
                // /admin/devices page so including them here would confuse
                // admins: the sidebar badge would always be higher than the
                // number of items visible when they land on the Approvals page.
                let badge;
                if (item.badgeKey === "approvals_page" && approvalsSummary) {
                  const n = (approvalsSummary.leaves || 0)
                          + (approvalsSummary.overtime || 0)
                          + (approvalsSummary.checkins || 0)
                          + (approvalsSummary.corrections || 0);
                  badge = n > 0 ? n : undefined;
                } else if (item.badgeKey) {
                  badge = approvalsSummary?.[item.badgeKey];
                }
                return (
                  <NavItem
                    key={item.to}
                    {...item}
                    badge={badge}
                    onClick={() => setOpen(false)}
                    onHoverPrefetch={prefetchFor(item.to)}
                  />
                );
              })}
              {/* Attendance masters — nested under the same Attendance
                  section so admins don't lose the visual grouping. */}
              <div className="mt-2 mb-1 px-3 text-[10px] font-black uppercase tracking-[0.15em] text-cyan-300/60">Masters</div>
              {NAV_ATTENDANCE_MASTERS.map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
            </SystemGroup>

            <SystemGroup label="Kitchen" tone="amber" icon={ChefHat}
                         count={NAV_KITCHEN.length}
                         open={isOpen("kitchen")} onToggle={() => toggleSection("kitchen")}>
              {NAV_KITCHEN.map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
            </SystemGroup>

            <SystemGroup label="System" tone="slate" icon={Settings}
                         count={NAV_SYSTEM.length}
                         open={isOpen("system")} onToggle={() => toggleSection("system")}>
              {NAV_SYSTEM.map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
            </SystemGroup>
          </>
        )}
      </nav>

      <div className="p-3 border-t border-slate-800">
        <NavLink
          to="/whats-new"
          onClick={() => setOpen(false)}
          data-testid="nav-whats-new"
          className={({ isActive }) =>
            `flex items-center gap-2 px-3 h-9 rounded-lg text-xs font-semibold transition mb-2 ${
              isActive ? "bg-sky-500/20 text-sky-300" : "text-slate-400 hover:bg-white/5 hover:text-sky-300"
            }`
          }
        >
          <Sparkles size={14} /> What&apos;s new
        </NavLink>
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={user?.full_name} photo={user?.photo} size={36} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" data-testid="sidebar-user-name">{user?.full_name}</div>
            <div className="text-xs text-slate-400 truncate">{user?.email}</div>
          </div>
        </div>
        <button
          data-testid="logout-button"
          onClick={handleLogout}
          className="w-full mt-2 flex items-center justify-center gap-2 h-10 rounded-lg bg-white/5 hover:bg-white/10 text-sm font-semibold transition"
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="h-screen overflow-hidden flex bg-slate-50">
      {/* Desktop sidebar */}
      <div className="hidden md:block h-screen">{sidebar}</div>

      {/* Mobile sidebar drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-y-0 left-0" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0 h-screen">
        {/* Mobile header */}
        <header className="md:hidden h-14 bg-white border-b border-slate-200 flex items-center px-4 shrink-0 z-30">
          <button data-testid="open-sidebar-button" onClick={() => setOpen(true)} className="p-2 -ml-2 rounded-lg hover:bg-slate-100">
            <Menu size={22} />
          </button>
          <div className="ml-2 flex items-center gap-2">
            <img src="/favicon.png" alt="YCH" className="w-6 h-6 object-contain" />
            <span className="font-extrabold">Yacht Club</span>
          </div>
          <div className="ml-auto flex items-center gap-2 min-w-0">
            <div
              className="hidden xs:flex flex-col text-right leading-tight min-w-0 max-w-[45vw]"
              data-testid="mobile-user-creds"
            >
              <span className="text-xs font-semibold truncate">{user?.full_name}</span>
              <span className="text-[10px] text-slate-500 truncate">
                {(user?.rank || user?.role || user?.category || "")}
                {(user?.email || user?.mobile) ? " · " : ""}
                {user?.email || user?.mobile || ""}
              </span>
            </div>
            <Avatar name={user?.full_name} photo={user?.photo} size={32} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <UserCredsChip />
      <StaleSessionPrompt />
      <InstallPrompt />
      <OfflineBanner />
      <HelpChat />
    </div>
  );
}

function SystemGroup({ label, tone = "cyan", icon: Icon, open, onToggle, count, children }) {
  // "System group" — top-level colour-coded container that houses one
  // whole subsystem (Attendance / Kitchen / System). A thin left border
  // in the accent colour visually ties every item inside the group
  // back to its section header. Aug 2026 sidebar reorg.
  //
  // `count` is rendered as a small pill next to the label ONLY when
  // the section is collapsed — a cue added after an admin accidentally
  // collapsed Attendance and thought Manage Members / Dashboard etc.
  // had vanished (Feb 2026 support ticket).
  const rail =
    tone === "amber" ? "border-amber-400/60"
    : tone === "slate" ? "border-slate-500/50"
    : "border-cyan-400/60";
  const bgTint =
    tone === "amber" ? "bg-amber-500/[0.04]"
    : tone === "slate" ? "bg-slate-500/[0.04]"
    : "bg-cyan-500/[0.04]";
  return (
    <div className={`mt-3 rounded-md border-l-2 ${rail} ${bgTint} pl-1.5 pr-0.5 py-1`}
         data-testid={`sysgroup-${label.toLowerCase()}`}>
      <SectionHeader label={label} open={open} onToggle={onToggle} tone={tone} icon={Icon}
                     hiddenCount={!open && typeof count === "number" ? count : null} />
      {open && <div className="pl-1 pt-1">{children}</div>}
    </div>
  );
}

function SectionHeader({ label, open, onToggle, tone = "cyan", icon: Icon, hiddenCount }) {
  // Collapsible section divider. Chevron indicates state, glow tint
  // matches the sidebar accent — cyan (attendance / member), amber
  // (kitchen), slate (system). Chevron rotation avoids re-rendering
  // the whole child list on state flips.
  const glow =
    tone === "amber" ? "text-amber-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]"
    : tone === "slate" ? "text-slate-300"
    : "text-cyan-300 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]";
  const pillTint =
    tone === "amber" ? "bg-amber-400/20 text-amber-100 ring-amber-300/40"
    : tone === "slate" ? "bg-slate-400/20 text-slate-100 ring-slate-300/40"
    : "bg-cyan-400/20 text-cyan-100 ring-cyan-300/40";
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={`section-${label.toLowerCase()}-toggle`}
      aria-expanded={open}
      title={hiddenCount ? `${hiddenCount} items hidden — click to expand` : undefined}
      className={`w-full flex items-center gap-1.5 text-[13px] font-black uppercase tracking-widest px-3 py-1.5 hover:bg-white/5 rounded-md transition ${glow}`}
    >
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      {Icon && <Icon size={13} />}
      <span>{label}</span>
      {hiddenCount ? (
        <span
          data-testid={`section-${label.toLowerCase()}-hidden-count`}
          className={`ml-auto min-w-[22px] h-5 px-1.5 rounded-full text-[10px] font-bold flex items-center justify-center tabular-nums ring-1 ${pillTint}`}
        >
          {hiddenCount}
        </span>
      ) : null}
    </button>
  );
}

function NavItem({ to, label, icon: Icon, end, onClick, onHoverPrefetch, disabled, disabledReason, highlight, badge, hint }) {
  // For links whose `to` carries a `?tab=` query, use a query-aware
  // active check so e.g. "Pantry Stock" (/admin/meals-report) and
  // "Kitchen Analytics" (/admin/meals-report?tab=analytics) don't
  // both light up at the same time. Falls through to the default
  // pathname-based `isActive` when no query is present.
  const loc = useLocation();
  const [rawPath, rawQuery] = String(to).split("?");
  const linkTab = rawQuery ? new URLSearchParams(rawQuery).get("tab") : null;
  const curTab = new URLSearchParams(loc.search).get("tab");
  const samePath = loc.pathname === rawPath;
  const queryActive = samePath && (linkTab
    ? curTab === linkTab
    // Base-link (no query): active only when no tab OR unrelated tab.
    // Concretely: "Pantry Stock" stays active on masters (default) but
    // dims when the user is on ?tab=analytics.
    : !curTab || (curTab === "masters"));
  if (disabled) {
    return (
      <div
        title={disabledReason || "Disabled"}
        data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-disabled`}
        className="flex items-center gap-3 px-3 h-9 rounded-lg text-[13px] font-medium mb-px text-slate-500 opacity-50 cursor-not-allowed select-none"
      >
        <Icon size={16} />
        <span className="flex-1">{label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">Off</span>
      </div>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      onMouseEnter={onHoverPrefetch}
      onFocus={onHoverPrefetch}
      title={hint}
      data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className={({ isActive }) => {
        // Base isActive from react-router is pathname-only. Refine it
        // for links that share a pathname but differ in ?tab= (see
        // comment above the component).
        const active = isActive && queryActive;
        return `flex items-center gap-3 px-3 h-9 rounded-lg text-[13px] font-medium transition mb-px ${
          highlight
            ? active
              ? "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/60"
              : "bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 ring-1 ring-amber-400/25"
            : active
              // Light-blue "you-are-here" pill on the dark sidebar
              // (user request 24 Feb 2026). Sky ring + tinted fill
              // makes the current page unmistakable.
              ? "bg-sky-400/25 text-sky-100 ring-1 ring-sky-400/60 font-semibold"
              : "text-slate-300 hover:bg-white/5 hover:text-white"
        }`;
      }}
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span
          className={`min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center tabular-nums ${
            highlight ? "bg-amber-400 text-amber-950" : "bg-rose-500 text-white"
          }`}
          data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-badge`}
          title={`${badge} pending`}
        >
          {badge}
        </span>
      )}
    </NavLink>
  );
}
