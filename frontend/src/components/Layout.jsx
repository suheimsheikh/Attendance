import React, { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import {
  Users, LayoutDashboard, QrCode, FileBarChart2, ScanLine, UserCog,
  CalendarCheck2, ClipboardList, Building2, IdCard, FileSpreadsheet,
  ShieldCheck, LogOut, Menu, X, ListTree, ClipboardCheck
} from "lucide-react";
import Avatar from "./Avatar";

const NAV_MEMBER = [
  { to: "/", label: "Presence", icon: LayoutDashboard, end: true },
  { to: "/check-in", label: "Check In / Out", icon: ScanLine },
  { to: "/my-leaves", label: "My Leave and Tour", icon: CalendarCheck2 },
  { to: "/profile", label: "Profile", icon: UserCog },
];

const NAV_ADMIN = [
  { to: "/admin", label: "Admin Console", icon: ShieldCheck, end: true },
  { to: "/admin/sessions", label: "Daily Sessions", icon: ListTree },
  { to: "/admin/members", label: "Members", icon: Users },
  { to: "/admin/leaves", label: "Leave Approvals", icon: ClipboardList },
  { to: "/admin/devices", label: "Access Requests", icon: IdCard },
  { to: "/admin/office", label: "Office Settings", icon: Building2 },
  { to: "/admin/office-qr", label: "Office QR", icon: QrCode, disabled: true, disabledReason: "QR scanning is disabled for now" },
  { to: "/admin/cards", label: "Member Cards", icon: IdCard, disabled: true, disabledReason: "QR scanning is disabled for now" },
  { to: "/admin/reports", label: "Reports", icon: FileBarChart2 },
  { to: "/admin/import", label: "Import Members", icon: FileSpreadsheet },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const isAdmin = user?.role === "admin";
  const canMuster = isAdmin || user?.category === "coach";

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
        <div className="text-[10px] uppercase tracking-widest text-slate-500 px-3 py-2">Member</div>
        {NAV_MEMBER.map((item) => (
          <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
        ))}
        {canMuster && (
          <NavItem
            to="/muster"
            label="Muster Roll"
            icon={ClipboardCheck}
            onClick={() => setOpen(false)}
          />
        )}
        {isAdmin && (
          <>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 px-3 py-2 mt-4">Admin</div>
            {NAV_ADMIN.map((item) => (
              <NavItem key={item.to} {...item} onClick={() => setOpen(false)} />
            ))}
          </>
        )}
      </nav>

      <div className="p-3 border-t border-slate-800">
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
    </div>
  );
}

function NavItem({ to, label, icon: Icon, end, onClick, disabled, disabledReason }) {
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
        `flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium transition mb-0.5 ${
          isActive ? "bg-white/10 text-white" : "text-slate-300 hover:bg-white/5 hover:text-white"
        }`
      }
    >
      <Icon size={17} />
      <span>{label}</span>
    </NavLink>
  );
}
