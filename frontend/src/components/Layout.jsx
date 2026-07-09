import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import {
  Users, LayoutDashboard, FileBarChart2, ScanLine, UserCog,
  CalendarCheck2, Building2, IdCard, Sailboat, MapPin,
  LogOut, Menu, ClipboardCheck, CalendarDays, Settings, MessageSquare, Database, Sparkles, UserCheck, Camera,
  ShieldAlert, Gauge, ChefHat, PencilRuler, KeyRound
} from "lucide-react";
import Avatar from "./Avatar";
import StaleSessionPrompt from "./StaleSessionPrompt";
import InstallPrompt from "./InstallPrompt";
import OfflineBanner from "./OfflineBanner";
import { api } from "../api";

const NAV_MEMBER = [
  { to: "/", label: "My Check In/Out", icon: ScanLine, end: true },
  { to: "/my-leaves", label: "Leave/Tour/Late", icon: CalendarCheck2 },
  // Correction requests raised by the member (missed check-ins, wrong
  // times, leave changes). Badge count = personal pending corrections,
  // fetched from `/api/me/corrections?status=pending` in the polling
  // loop below (8 Jul 2026 user request "bring all correction requests
  // by a member under member in the main menu").
  { to: "/my-corrections", label: "My Corrections", icon: PencilRuler, badgeKey: "my_corrections" },
  // Escort kiosk: visible to every signed-in user. Athletes/coaches/staff
  // help mark escorts in/out — escorts themselves land here after phone
  // login (auth.jsx forces the redirect when `is_escort=true`).
  { to: "/escort-checkin", label: "Escorts Check in/Out", icon: UserCheck },
  { to: "/profile", label: "My Profile", icon: UserCog },
];

// Coach section — visible to coaches & admins only. Presence and Muster were
// previously visible to every signed-in user; moving them here makes it
// explicit that they're operational tools, not member-tier features.
const NAV_COACH = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck },
  { to: "/presence", label: "Presence", icon: LayoutDashboard },
];

// Chef section — visible to users with role="chef". Kitchen staff who
// need the same operational read-access as coaches PLUS the Chef's View
// meal-planning page. Added 4 Feb 2026 with the Roles master.
const NAV_CHEF = [
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat },
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck },
  { to: "/presence", label: "Presence", icon: LayoutDashboard },
];

// Members lives at the top of the ADMIN section (admin-only access). Leave
// Balances moved into the Admin Console grid since it's not opened daily.
// Sidebar admin entries. Presence Board (in NAV_COACH above) is now the
// landing page for admins — it carries the OT banners + "Coming up this week"
// strip that used to live on the Admin Console.
const NAV_ADMIN = [
  { to: "/admin/dashboard", label: "Dashboard", icon: Gauge, end: true },
  { to: "/admin/members", label: "Manage Members", icon: Users },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat },
  { to: "/admin/approvals", label: "Approvals", icon: ClipboardCheck, highlight: true, badgeKey: "approvals_page" },
  { to: "/admin/leave-balances", label: "Leave Balances", icon: CalendarCheck2 },
  { to: "/admin/devices", label: "Access Requests", icon: IdCard },
  { to: "/admin/reports", label: "Reports", icon: FileBarChart2 },
  { to: "/admin/sms-log", label: "SMS Log", icon: MessageSquare },
  { to: "/admin/institutions", label: "Institutions", icon: Building2 },
  { to: "/admin/fleets", label: "Fleets", icon: Sailboat },
  { to: "/admin/categories", label: "Categories", icon: ShieldAlert },
  { to: "/admin/category-health", label: "Category Health", icon: ShieldAlert },
  { to: "/admin/roles", label: "Roles", icon: KeyRound },
  { to: "/admin/sites", label: "Training Locations", icon: MapPin },
  { to: "/admin/office", label: "Office Settings", icon: Settings },
  { to: "/admin/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/admin/escort-photos", label: "Escort Photo Cleanup", icon: Camera },
  { to: "/admin/data-quality", label: "Data Quality", icon: ShieldAlert },
  { to: "/admin/audit-log", label: "Audit Log", icon: ScanLine },
  { to: "/admin/backup", label: "Backup & Restore", icon: Database },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const isAdmin = user?.role === "admin";
  const isChef = user?.role === "chef";
  const canMuster = isAdmin || user?.category === "coach" || isChef;
  // Escort sessions get a stripped-down sidebar — only the kiosk link,
  // Muster Roll (institution-scoped server-side), and Sign out. They have
  // no member/coach/admin permissions otherwise.
  const isEscort = !!user?.is_escort;

  // Pending-approvals badge — one polling loop, badge attached to the
  // Approvals nav item. Kept quiet on failures so a temporarily-slow
  // backend doesn't clog the sidebar with error toasts.
  const [approvalsSummary, setApprovalsSummary] = React.useState(null);
  React.useEffect(() => {
    if (!isAdmin || isEscort) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await api.get("/admin/approvals-summary");
        if (!cancelled) setApprovalsSummary(s);
      } catch (err) {
        console.debug("approvals-summary fetch:", err?.message);
      }
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isAdmin, isEscort]);

  // Member-side pending-corrections badge. Polled every 60 s alongside
  // the admin summary above. Skipped for escort tokens (they have no
  // corrections page anyway). 8 Jul 2026 user request "bring all
  // correction requests by a member under member in the main menu".
  const [myPendingCorrections, setMyPendingCorrections] = React.useState(0);
  React.useEffect(() => {
    if (isEscort) return undefined;
    let cancelled = false;
    const refresh = async () => {
      try {
        const rows = await api.get("/me/corrections?status=pending");
        if (!cancelled) setMyPendingCorrections(Array.isArray(rows) ? rows.length : 0);
      } catch (err) {
        console.debug("my corrections fetch:", err?.message);
      }
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [isEscort]);

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
    <aside className="w-64 shrink-0 bg-slate-900 text-slate-100 flex flex-col" data-testid="app-sidebar">
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-slate-800">
        <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center overflow-hidden">
          <img src="/favicon.png" alt="YCH" className="w-8 h-8 object-contain" />
        </div>
        <div>
          <div className="font-extrabold tracking-tight text-[15px] leading-none">Yacht Club</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400 mt-1">of Hyderabad</div>
        </div>
      </div>

      <nav className="px-3 py-4 flex-1 overflow-y-auto">
        <div className="text-base font-black uppercase tracking-widest text-cyan-300 px-3 py-2.5 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]">Member</div>
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
            <div className="text-base font-black uppercase tracking-widest text-cyan-300 px-3 py-2.5 mt-4 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]">Coach</div>
            {NAV_COACH.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
          </>
        )}
        {!isEscort && isChef && (
          <>
            <div className="text-base font-black uppercase tracking-widest text-amber-300 px-3 py-2.5 mt-4 drop-shadow-[0_0_8px_rgba(251,191,36,0.45)]">Chef</div>
            {NAV_CHEF.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
          </>
        )}
        {!isEscort && isAdmin && (
          <>
            <div className="text-base font-black uppercase tracking-widest text-cyan-300 px-3 py-2.5 mt-4 drop-shadow-[0_0_8px_rgba(34,211,238,0.45)]">Admin</div>
            {NAV_ADMIN.map((item) => {
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
                />
              );
            })}
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
    <div className="min-h-screen flex bg-slate-50">
      {/* Desktop sidebar */}
      <div className="hidden md:block">{sidebar}</div>

      {/* Mobile sidebar drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="absolute inset-y-0 left-0" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="md:hidden h-14 bg-white border-b border-slate-200 flex items-center px-4 sticky top-0 z-30">
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
    </div>
  );
}

function NavItem({ to, label, icon: Icon, end, onClick, disabled, disabledReason, highlight, badge }) {
  if (disabled) {
    return (
      <div
        title={disabledReason || "Disabled"}
        data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-disabled`}
        className="flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium mb-0.5 text-slate-500 opacity-50 cursor-not-allowed select-none"
      >
        <Icon size={17} />
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
      data-testid={`nav-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      className={({ isActive }) =>
        // The Approvals row gets a persistent amber tint + brighter border
        // so it stays visually loud (there's always work to review). When
        // active it gets an even stronger amber background so admins
        // don't lose their place.
        `flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium transition mb-0.5 ${
          highlight
            ? isActive
              ? "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/60"
              : "bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 ring-1 ring-amber-400/25"
            : isActive
              ? "bg-white/10 text-white"
              : "text-slate-300 hover:bg-white/5 hover:text-white"
        }`
      }
    >
      <Icon size={17} />
      <span className="flex-1">{label}</span>
      {typeof badge === "number" && badge > 0 && (
        <span
          // Show the actual pending count — no 99+ cap. Admins want the
          // real backlog size at a glance so they can prioritise; the pill
          // grows horizontally to fit 3–4 digit numbers (px-1.5 + auto width).
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
