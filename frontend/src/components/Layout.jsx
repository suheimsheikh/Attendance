import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import {
  Users, ClipboardCheck, Settings, ChefHat, ListTodo, LogOut, Menu, Sparkles, PanelLeftClose, GraduationCap,
} from "lucide-react";
import RulesGate from "./RulesGate";
import Avatar from "./Avatar";
import StaleSessionPrompt from "./StaleSessionPrompt";
import LeaveReportPrompt from "./LeaveReportPrompt";
import AbsentDispatchPrompt from "./AbsentDispatchPrompt";
import { PassportExpiryPrompt } from "./PassportExpiryPrompt";
import InstallPrompt from "./InstallPrompt";
import OfflineBanner from "./OfflineBanner";
import HelpChat from "./HelpChat";
import UserCredsChip from "./UserCredsChip";
import LeaveDecisionBanner from "./LeaveDecisionBanner";
import { api } from "../api";
import { useUiPrefs } from "../hooks/useUiPrefs";
import { useApiQuery } from "../hooks/useApiQuery";
import { useEscape } from "../hooks/useEscape";
import { usePageUsagePing } from "../hooks/usePageUsagePing";
import { useQueryClient } from "@tanstack/react-query";
import { useAppEvents } from "../hooks/useAppEvents";
import CorrectionsWaitingBanner from "./CorrectionsWaitingBanner";
import {
  PREFETCH_MAP, NAV_MEMBER, NAV_COACH_ATTENDANCE, NAV_COACH_KITCHEN, NAV_ATTENDANCE_LIVE, NAV_KITCHEN, NAV_SYSTEM,
} from "./layout/navConfig";
import { SystemGroup, NavItem } from "./layout/NavParts";

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  useEscape(open ? () => setOpen(false) : null);
  const isAdmin = user?.role === "admin";
  const isChef = user?.role === "chef";
  usePageUsagePing();
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
      refetchInterval: 5 * 60_000,  // fallback only — live updates arrive via /api/events SSE
      refetchIntervalInBackground: false,
    },
  );
  const approvalsSummary = approvalsSummaryQuery.data || null;

  // Collapsible sidebar sections (04 Feb 2026). Backed by useUiPrefs
  // so an admin's collapse choice syncs across devices — laptop and
  // phone remember which sections they hide. Falls back to
  // localStorage-only when offline / unauthenticated.
  const [uiPrefs, patchUiPrefs] = useUiPrefs({ sidebar_collapsed: [], sidebar_hidden: false });
  const sidebarHidden = !!uiPrefs.sidebar_hidden;
  const setSidebarHidden = React.useCallback(
    (v) => patchUiPrefs({ sidebar_hidden: v }), [patchUiPrefs]);
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
      refetchInterval: 5 * 60_000,  // fallback only — live updates arrive via /api/events SSE
      refetchIntervalInBackground: false,
    },
  );
  useAppEvents(!isEscort);
  const myPendingCorrections = Array.isArray(myCorrectionsQuery.data)
    ? myCorrectionsQuery.data.length
    : 0;

  const memberNav = isEscort
    ? [
        ...NAV_MEMBER.filter((n) => n.to === "/escort-checkin"),
        { to: "/muster", label: "Muster Roll", icon: ClipboardCheck },
      ]
    : (isAdmin || user?.category === "executive" || user?.category === "coach")
      ? [...NAV_MEMBER.slice(0, -1), { to: "/tasks", label: "Task Manager", icon: ListTodo, badgeKey: "tasks_today", hint: "Team to-dos with deadlines and your daily / weekly / monthly checklist" }, NAV_MEMBER[NAV_MEMBER.length - 1]]
      : NAV_MEMBER;
  const tasksTodayQuery = useApiQuery(
    "/tasks/today", undefined,
    { enabled: !isEscort && (isAdmin || user?.category === "executive" || user?.category === "coach"), staleTime: 30_000, refetchInterval: 60_000, refetchIntervalInBackground: false },
  );
  const tasksPending = tasksTodayQuery.data?.enabled ? (tasksTodayQuery.data.pending || 0) : 0;

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
        {/* Hide sidebar (desktop/tablet). Mobile uses the drawer's tap-out. */}
        <button
          type="button"
          data-testid="hide-sidebar-button"
          onClick={() => { setSidebarHidden(true); setOpen(false); }}
          title="Hide menu"
          className="ml-auto hidden md:flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <nav className="px-3 py-3 flex-1 overflow-y-auto">
        <div className="text-[13px] font-black uppercase tracking-widest text-cyan-300 px-3 py-1.5 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]">Member</div>
        {memberNav.map((item) => {
          // Member section's only badged item today is My Corrections.
          const badge = item.badgeKey === "my_corrections"
            ? (myPendingCorrections > 0 ? myPendingCorrections : undefined)
            : item.badgeKey === "tasks_today"
              ? (tasksPending > 0 ? tasksPending : undefined)
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
                         count={NAV_ATTENDANCE_LIVE.length + 1}
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
              {/* All master-data screens now live under one Masters
                  page (tabbed). Single entry keeps the sidebar tidy. */}
              <NavItem to="/admin/masters" label="Masters" icon={Users} onClick={() => setOpen(false)}
                       hint="Members, Institutions, Fleets, Categories and Roles — all in one place" />
            </SystemGroup>

            <SystemGroup label="Kitchen" tone="amber" icon={ChefHat}
                         count={NAV_KITCHEN.length}
                         open={isOpen("kitchen")} onToggle={() => toggleSection("kitchen")}>
              {NAV_KITCHEN.map((item) => (
                <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
              ))}
            </SystemGroup>

            <NavItem to="/admin/education" label="Education" icon={GraduationCap} onClick={() => setOpen(false)}
                     hint="Marksheets for athletes & coaches — scan, upload and track exams" />

            <SystemGroup label="System" tone="slate" icon={Settings}
                         count={NAV_SYSTEM.length}
                         open={isOpen("system")} onToggle={() => toggleSection("system")}>
              {NAV_SYSTEM.filter((item) => !item.superOnly || user?.is_super_admin).map((item) => (
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
        <button title="Sign out of this device"
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
      <RulesGate enabled={!!user && !isEscort} />
      {/* Desktop sidebar — hideable on desktop/tablet via useUiPrefs */}
      {!sidebarHidden && <div className="hidden md:block h-screen">{sidebar}</div>}

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
        {/* Top header — always on mobile; also on desktop/tablet when the
            sidebar is hidden (so the menu can be reopened). */}
        <header className={`h-14 bg-white border-b border-slate-200 flex items-center px-4 shrink-0 z-30 ${sidebarHidden ? "flex" : "md:hidden"}`}>
          <button
            data-testid="open-sidebar-button"
            onClick={() => { setOpen(true); setSidebarHidden(false); }}
            title="Show menu"
            className="p-2 -ml-2 rounded-lg hover:bg-slate-100"
          >
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
          <LeaveDecisionBanner />
          <CorrectionsWaitingBanner enabled={!!isAdmin && !isEscort} />
          <Outlet />
        </main>
      </div>
      <UserCredsChip />
      <StaleSessionPrompt />
      {isAdmin && !isEscort && <LeaveReportPrompt />}
      {(isAdmin || user?.category === "coach") && !isEscort && <AbsentDispatchPrompt />}
      {isAdmin && !isEscort && <PassportExpiryPrompt />}
      <InstallPrompt />
      <OfflineBanner />
      <HelpChat />
    </div>
  );
}
