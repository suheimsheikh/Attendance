import React, { useEffect, useState } from "react";
import { Users, CalendarCheck2, Plane, Clock, ShieldCheck, ArrowRight, AlertTriangle, ChevronRight, Calendar, ClipboardCheck, ClipboardList, FileSpreadsheet, Building2, IdCard, Building, FileBarChart2 } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import ActivityFeed from "../../components/ActivityFeed";

export default function AdminConsole() {
  const [summary, setSummary] = useState(null);
  const [otNeedsReview, setOtNeedsReview] = useState(null);

  useEffect(() => {
    api.get("/admin/summary").then(setSummary).catch(() => {});
    api.get("/admin/overtime/needs-review").then(setOtNeedsReview).catch(() => {});
  }, []);

  // 5 summary tiles — each gets a vibrant colour to make scanning easier.
  const cards = [
    { label: "Total members", value: summary?.total_members ?? "—", Icon: Users, color: "#0EA5E9", to: "/admin/members" },
    { label: "On campus now", value: summary?.on_campus ?? "—", Icon: ShieldCheck, color: "#10B981", to: "/presence" },
    { label: "Pending leaves", value: summary?.pending_leaves ?? "—", Icon: CalendarCheck2, color: "#F59E0B", to: "/admin/leaves" },
    { label: "On leave / tour", value: summary?.on_leave_tour ?? "—", Icon: Plane, color: "#F97316", to: "/admin/leaves" },
    { label: "Late today", value: summary?.late_today ?? "—", Icon: Clock, color: "#EF4444", to: "/admin/reports" },
  ];

  // Each quick-action card has its own colour theme: vivid icon, soft tinted
  // background + matching border so admins can recognise each shortcut at a
  // glance instead of reading text.
  const links = [
    { to: "/admin/sessions",       label: "Daily sessions",     desc: "Check-in, temp exits/returns & final check-out in one table", Icon: Calendar,         color: "#10B981" },
    { to: "/admin/members",        label: "Manage members",     desc: "Add, edit, deactivate members",                              Icon: Users,             color: "#0EA5E9" },
    { to: "/admin/leaves",         label: "Approve leaves",     desc: "Review pending leave & tour requests",                        Icon: ClipboardList,    color: "#F59E0B" },
    { to: "/admin/overtime",       label: "Overtime approvals", desc: "Approve / reject staff overtime entries",                     Icon: ClipboardCheck,   color: "#8B5CF6" },
    { to: "/admin/leave-balances", label: "Leave balances",     desc: "Set opening balances & see consumed / pending",               Icon: CalendarCheck2,   color: "#06B6D4" },
    { to: "/admin/payroll",        label: "Monthly payroll",    desc: "Generate the monthly payroll report",                         Icon: FileSpreadsheet,  color: "#F97316" },
    { to: "/admin/institutions",   label: "Institutions",       desc: "Manage the institutions list (MJPT, Rainbow Home, YCH…)",     Icon: Building,         color: "#6366F1" },
    { to: "/admin/devices",        label: "Access requests",    desc: "Approve new browser/device sign-ins",                         Icon: IdCard,            color: "#F43F5E" },
    { to: "/admin/office",         label: "Office settings",    desc: "Geofence, work hours, timezone",                              Icon: Building2,         color: "#14B8A6" },
    { to: "/admin/reports",        label: "Reports",            desc: "Hours, attendance, exports",                                  Icon: FileBarChart2,     color: "#EC4899" },
    { to: "/admin/import",         label: "Import members",     desc: "Bulk upload via Excel template",                              Icon: FileSpreadsheet,  color: "#84CC16" },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Admin Console</h1>
        <p className="text-slate-500 text-sm mt-1">Everything you need to run the campus.</p>
      </header>

      {otNeedsReview && (otNeedsReview.total_pending > 0 || otNeedsReview.comp_off_pending > 0) && (
        <div className="space-y-3 mb-6">
          {otNeedsReview.total_pending > 0 && (
            <Link
              to={`/admin/overtime?status=pending${otNeedsReview.yesterday ? `&from=${otNeedsReview.yesterday}&to=${otNeedsReview.yesterday}` : ""}`}
              className="block iu-card p-4 border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 transition"
              data-testid="overtime-banner"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-extrabold text-amber-900">
                    {otNeedsReview.yesterday_count > 0
                      ? `${otNeedsReview.yesterday_count} overtime ${otNeedsReview.yesterday_count === 1 ? "entry" : "entries"} from yesterday need your review`
                      : `${otNeedsReview.total_pending} pending overtime ${otNeedsReview.total_pending === 1 ? "entry" : "entries"} to review`}
                  </div>
                  <div className="text-xs text-amber-800 mt-0.5">Tap to approve or reject with a note.</div>
                </div>
                <ChevronRight size={20} className="text-amber-700 shrink-0" />
              </div>
            </Link>
          )}
          {otNeedsReview.comp_off_pending > 0 && (
            <Link
              to="/admin/leaves?type=comp_off"
              className="block iu-card p-4 border-2 border-violet-300 bg-violet-50 hover:bg-violet-100 transition"
              data-testid="comp-off-banner"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-full bg-violet-200 text-violet-800 flex items-center justify-center shrink-0">
                  <AlertTriangle size={20} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-extrabold text-violet-900">
                    {otNeedsReview.comp_off_pending} compensatory off {otNeedsReview.comp_off_pending === 1 ? "request" : "requests"} awaiting approval
                  </div>
                  <div className="text-xs text-violet-800 mt-0.5">Members claimed comp-offs for working on their weekly off — review them.</div>
                </div>
                <ChevronRight size={20} className="text-violet-700 shrink-0" />
              </div>
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8" data-testid="admin-summary-cards">
        {cards.map((c) => (
          <Link
            key={c.label}
            to={c.to}
            className="iu-card p-4 hover:shadow-lg transition border-2"
            style={{
              background: `linear-gradient(135deg, ${c.color}18 0%, ${c.color}05 100%)`,
              borderColor: c.color + "33",
            }}
            data-testid={`summary-${c.label.toLowerCase().replace(/\s+/g, "-")}`}
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3 shadow-sm" style={{ background: c.color, color: "#fff" }}>
              <c.Icon size={20} />
            </div>
            <div className="text-2xl font-extrabold" style={{ color: c.color }}>{c.value}</div>
            <div className="text-xs font-bold uppercase tracking-wide mt-0.5 text-slate-700">{c.label}</div>
          </Link>
        ))}
      </div>

      <h2 className="font-extrabold tracking-tight mb-3">Quick actions</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-8">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            data-testid={`link-${l.to.replace(/\W+/g, "-")}`}
            className="iu-card p-4 hover:shadow-lg transition flex items-center gap-3 border-2"
            style={{
              backgroundColor: l.color + "10",   // ~6% opacity tint
              borderColor: l.color + "33",       // ~20% opacity border
            }}
          >
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
              style={{ backgroundColor: l.color, color: "#fff" }}
            >
              <l.Icon size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-bold text-slate-900">{l.label}</div>
              <div className="text-xs text-slate-600 mt-0.5">{l.desc}</div>
            </div>
            <ArrowRight size={16} style={{ color: l.color }} />
          </Link>
        ))}
      </div>

      <ActivityFeed />
    </div>
  );
}
