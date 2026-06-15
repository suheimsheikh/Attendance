import React, { useEffect, useState } from "react";
import { Users, CalendarCheck2, Plane, Clock, ShieldCheck, ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api";

export default function AdminConsole() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api.get("/admin/summary").then(setSummary).catch(() => {});
  }, []);

  const cards = [
    { label: "Total members", value: summary?.total_members ?? "—", Icon: Users, color: "#111827", to: "/admin/members" },
    { label: "On campus now", value: summary?.on_campus ?? "—", Icon: ShieldCheck, color: "#10B981", to: "/" },
    { label: "Pending leaves", value: summary?.pending_leaves ?? "—", Icon: CalendarCheck2, color: "#F59E0B", to: "/admin/leaves" },
    { label: "On leave / tour", value: summary?.on_leave_tour ?? "—", Icon: Plane, color: "#F97316", to: "/admin/leaves" },
    { label: "Late today", value: summary?.late_today ?? "—", Icon: Clock, color: "#EF4444", to: "/admin/reports" },
  ];

  const links = [
    { to: "/admin/members", label: "Manage members", desc: "Add, edit, deactivate members" },
    { to: "/admin/leaves", label: "Approve leaves", desc: "Review pending leave & tour requests" },
    { to: "/admin/devices", label: "Access requests", desc: "Approve new browser/device sign-ins" },
    { to: "/admin/office", label: "Office settings", desc: "Geofence, work hours, timezone" },
    { to: "/admin/office-qr", label: "Office QR", desc: "Display & regenerate the check-in QR" },
    { to: "/admin/reports", label: "Reports", desc: "Hours, attendance, exports" },
    { to: "/admin/import", label: "Import members", desc: "Bulk upload via Excel template" },
    { to: "/admin/cards", label: "Member cards", desc: "Print personal QR cards" },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Admin Console</h1>
        <p className="text-slate-500 text-sm mt-1">Everything you need to run the campus.</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8" data-testid="admin-summary-cards">
        {cards.map((c) => (
          <Link key={c.label} to={c.to} className="iu-card p-4 hover:shadow-md transition" data-testid={`summary-${c.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3" style={{ background: c.color + "22", color: c.color }}>
              <c.Icon size={18} />
            </div>
            <div className="text-2xl font-extrabold">{c.value}</div>
            <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mt-0.5">{c.label}</div>
          </Link>
        ))}
      </div>

      <h2 className="font-extrabold tracking-tight mb-3">Quick actions</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {links.map((l) => (
          <Link key={l.to} to={l.to} className="iu-card p-4 hover:shadow-md transition flex items-center" data-testid={`link-${l.to.replace(/\W+/g, "-")}`}>
            <div className="flex-1">
              <div className="font-semibold">{l.label}</div>
              <div className="text-xs text-slate-500 mt-0.5">{l.desc}</div>
            </div>
            <ArrowRight size={16} className="text-slate-400" />
          </Link>
        ))}
      </div>
    </div>
  );
}
