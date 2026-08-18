import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import {
  Users, LayoutDashboard, FileBarChart2, ScanLine, UserCog,
  CalendarCheck2, Building2, IdCard, Sailboat,
  LogOut, Menu, ClipboardCheck, CalendarDays, Settings, MessageSquare, Database, Sparkles, UserCheck, Camera,
  ShieldAlert, Gauge, ChefHat, PencilRuler, KeyRound, ChevronDown, ChevronRight, TrendingDown, Utensils
} from "lucide-react";
import Avatar from "./Avatar";
import StaleSessionPrompt from "./StaleSessionPrompt";
import InstallPrompt from "./InstallPrompt";
import OfflineBanner from "./OfflineBanner";
import HelpChat from "./HelpChat";
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
  "/admin/churn-risk":  ["/reports/churn-risk", { window_days: 30, threshold: 0.4 }],
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

// Coach + Chef sections — visible to coaches, chefs & admins per role.
// Ordered per user spec (04 Feb 2026): Muster Roll → Chef's View → Presence.
// Chef's View is now shared across coaches/chefs/admins so on-the-ground
// staff can see meal counts alongside the muster.
const NAV_COACH = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/meals", label: "Meals", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-report", label: "Pantry Stock", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, issues, wastage and stock" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
];

const NAV_CHEF = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/meals", label: "Meals", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-report", label: "Pantry Stock", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, issues, wastage and stock" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
];

// ADMIN section — day-to-day operational surfaces. Kept intentionally
// short so the sidebar stays scannable; masters + system live below.
// SMS Log moved to SYSTEM section on 15 Feb 2026 per admin — it's a
// diagnostics / audit surface, not a day-to-day tool.
const NAV_ADMIN = [
  { to: "/admin/calendar", label: "Calendar", icon: CalendarDays, hint: "Holidays, weekly offs, camps and regattas at a glance" },
  { to: "/admin/dashboard", label: "Dashboard", icon: Gauge, end: true, hint: "Single-glance summary: on campus, on leave, alerts" },
  { to: "/admin/members", label: "Manage Members", icon: Users, hint: "Add, edit and organise athletes, staff and coaches" },
  // Highlighted bright yellow — this is the single most-visited
  // reporting surface (all-in-one 31-day view).
  { to: "/admin/reports", label: "The Grid", icon: FileBarChart2, spotlight: true, hint: "All-in-one 31-day attendance grid with drill-downs and exports" },
  { to: "/admin/approvals", label: "Approvals", icon: ClipboardCheck, highlight: true, badgeKey: "approvals_page", hint: "Pending leaves, corrections and check-in approvals in one queue" },
  { to: "/admin/meals-report", label: "Pantry Stock", icon: Utensils, hint: "Kitchen inventory: items, purchases, issues, wastage and stock" },
  { to: "/admin/churn-risk", label: "Churn Risk", icon: TrendingDown, hint: "Members whose attendance is fading — catch them before they drop off" },
  { to: "/admin/devices", label: "Access Requests", icon: IdCard, hint: "Approve or block new phones/devices requesting access" },
  { to: "/admin/leave-balances", label: "Leave Balances", icon: CalendarCheck2, hint: "Paid leave, comp-off and tour balances for every member" },
];

// MASTERS section — reference data admins tune occasionally.
const NAV_MASTERS = [
  { to: "/admin/institutions", label: "Institutions", icon: Building2, hint: "Schools/colleges members belong to" },
  { to: "/admin/fleets", label: "Fleets", icon: Sailboat, hint: "Boat fleets and class groupings" },
  { to: "/admin/categories", label: "Categories", icon: ShieldAlert, hint: "Member categories and their attendance rules" },
  { to: "/admin/roles", label: "Roles", icon: KeyRound, hint: "Who can see and do what in the app" },
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
        {!isEscort && canMuster && !isChef && (
          <>
            <SectionHeader
              label="Coaches"
              open={isOpen("coaches")}
              onToggle={() => toggleSection("coaches")}
              tone="cyan"
            />
            {isOpen("coaches") && NAV_COACH
              .filter((item) => !(isAdmin && item.to === "/admin/meals-report"))
              .map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
          </>
        )}
        {!isEscort && isChef && (
          <>
            <SectionHeader
              label="Chef"
              open={isOpen("chef")}
              onToggle={() => toggleSection("chef")}
              tone="amber"
            />
            {isOpen("chef") && NAV_CHEF.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
          </>
        )}
        {!isEscort && isAdmin && (
          <>
            <SectionHeader
              label="Admin"
              open={isOpen("admin")}
              onToggle={() => toggleSection("admin")}
              tone="cyan"
            />
            {isOpen("admin") && NAV_ADMIN.map((item) => {
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
            <SectionHeader
              label="Masters"
              open={isOpen("masters")}
              onToggle={() => toggleSection("masters")}
              tone="cyan"
            />
            {isOpen("masters") && NAV_MASTERS.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
            <SectionHeader
              label="System"
              open={isOpen("system")}
              onToggle={() => toggleSection("system")}
              tone="cyan"
            />
            {isOpen("system") && NAV_SYSTEM.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
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
          <div className="ml-auto">
            <Avatar name={user?.full_name} photo={user?.photo} size={32} />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <StaleSessionPrompt />
      <InstallPrompt />
      <OfflineBanner />
      <HelpChat />
    </div>
  );
}

function SectionHeader({ label, open, onToggle, tone = "cyan" }) {
  // Collapsible section divider. Chevron indicates state, glow tint
  // matches the sidebar accent (cyan for member/coach/admin/masters/
  // system; amber for chef). Chevron rotation avoids re-rendering the
  // whole child list on state flips.
  const glow = tone === "amber"
    ? "text-amber-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]"
    : "text-cyan-300 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]";
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={`section-${label.toLowerCase()}-toggle`}
      aria-expanded={open}
      className={`w-full flex items-center gap-1 text-[13px] font-black uppercase tracking-widest px-3 py-1.5 mt-2 hover:bg-white/5 rounded-md transition ${glow}`}
    >
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      <span>{label}</span>
    </button>
  );
}

function NavItem({ to, label, icon: Icon, end, onClick, onHoverPrefetch, disabled, disabledReason, highlight, spotlight, badge, hint }) {
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
      className={({ isActive }) =>
        // Three variants, mutually exclusive:
        //  • `spotlight` — bright yellow (The Grid, 15 Feb 2026): the most-visited
        //    reporting surface; we want admins to spot it instantly.
        //  • `highlight` — amber (Approvals): persistent nag for pending work.
        //  • neutral    — the default slate treatment.
        `flex items-center gap-3 px-3 h-9 rounded-lg text-[13px] font-medium transition mb-px ${
          spotlight
            ? isActive
              ? "bg-yellow-400 text-yellow-950 ring-2 ring-yellow-300 font-extrabold"
              : "bg-yellow-400 text-yellow-950 hover:bg-yellow-300 ring-1 ring-yellow-300/70 font-extrabold"
            : highlight
              ? isActive
                ? "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/60"
                : "bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 ring-1 ring-amber-400/25"
              : isActive
                // Light-blue "you-are-here" pill on the dark sidebar
                // (user request 24 Feb 2026). Sky ring + tinted fill
                // makes the current page unmistakable without
                // fighting the spotlight/highlight variants above.
                ? "bg-sky-400/25 text-sky-100 ring-1 ring-sky-400/60 font-semibold"
                : "text-slate-300 hover:bg-white/5 hover:text-white"
        }`
      }
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span
          className={`min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center tabular-nums ${
            spotlight ? "bg-yellow-900 text-yellow-100" :
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
