/**
 * Dashboard — single-glance admin landing page.
 *
 * Consumes `/api/admin/dashboard` (one round-trip aggregate) and lays
 * out four zones:
 *   • Top strip   — "Now"      (on-campus, late, absent, guests, escorts,
 *                                pending approvals)
 *   • Middle band — "This week" (sparkline, top late-comers, birthdays,
 *                                camps/regattas)
 *   • Bottom band — "This month"(staff hours, OT hrs, leave consumed,
 *                                new members)
 *   • Right rail  — "Attention" (pending queues, DQ signals)
 *
 * Every widget is a clickable link that deep-jumps into the existing
 * page for the detail view — zero new subsystems.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Loader2, RefreshCw, Users, Cake, Sailboat, Trophy, UserCheck,
  AlertTriangle, Clock, ArrowRight, TrendingUp, ClipboardCheck,
  IdCard, ShieldAlert, Calendar as CalendarIcon, MapPin,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import MonthCorrectionsCard from "./dashboard/MonthCorrectionsCard";
import {
  CATEGORY_COLOR, StatTile, CategoryChips, Sparkline,
  fmtRange, SectionCard, AttentionRow, ShortcutBtn,
} from "./dashboard/widgets";

// ----- Widgets moved to ./dashboard/widgets.jsx --------------------
// CATEGORY_COLOR, StatTile, CategoryChips, Sparkline, fmtShortDate,
// fmtRange, SectionCard, AttentionRow, ShortcutBtn all live there now.

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloading, setReloading] = useState(false);
  const inflightRef = React.useRef(false);

  const load = useCallback(async (soft = false) => {
    if (inflightRef.current) return;      // guard against concurrent refreshes
    inflightRef.current = true;
    if (soft) setReloading(true); else setLoading(true);
    try {
      const r = await api.get("/admin/dashboard");
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Failed to load dashboard");
    } finally {
      setLoading(false);
      setReloading(false);
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 60 s on visible tabs, mirroring Presence Board.
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, 60_000);
    return () => clearInterval(iv);
  }, [load]);

  const attentionTotal = useMemo(() => {
    if (!data?.attention) return 0;
    const a = data.attention;
    // OT approval workflow removed 15 Feb 2026 — pending_overtime is
    // always 0 now, but keep the summand for backward compat with
    // older server responses that might still include it.
    return (a.pending_leaves || 0)
      + (a.pending_overtime || 0)
      + (a.pending_devices || 0)
      + (a.stale_sessions || 0)
      + (a.athletes_no_parent_contact || 0);
  }, [data]);

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center" data-testid="dashboard-loading">
        <Loader2 className="animate-spin text-slate-400" size={28} />
      </div>
    );
  }
  if (!data) return null;

  const { now, week, month, attention, today } = data;

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto" data-testid="admin-dashboard-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900" data-testid="dashboard-heading">
            Admin Dashboard
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {new Date(today + "T00:00:00").toLocaleDateString(undefined, {
              weekday: "long", day: "2-digit", month: "long", year: "numeric",
            })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={reloading}
          className="inline-flex items-center gap-2 px-3 h-9 rounded-lg text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-50"
          data-testid="dashboard-refresh"
        >
          {reloading
            ? <Loader2 size={14} className="animate-spin" />
            : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-5">
        {/* ── MAIN COLUMN ─────────────────────────────────── */}
        <div className="space-y-5">
          {/* NOW */}
          <SectionCard title="Now" testid="dashboard-now">
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <StatTile
                testid="dashboard-tile-oncampus"
                label="On campus"
                value={now.on_campus_total}
                sub={<CategoryChips counts={now.on_campus_by_category} />}
                icon={Users}
                tone="emerald"
                to="/presence"
              />
              <StatTile
                testid="dashboard-tile-late-today"
                label="Late today"
                value={now.late_today}
                sub="Since 09:30 grace"
                icon={Clock}
                tone={now.late_today > 0 ? "rose" : "slate"}
                to="/presence?late=1"
              />
              <StatTile
                testid="dashboard-tile-absent"
                label="Absent athletes"
                value={now.absent_athletes_today}
                sub="Unaccounted for today"
                icon={AlertTriangle}
                tone={now.absent_athletes_today > 0 ? "amber" : "slate"}
                to="/presence"
              />
              <StatTile
                testid="dashboard-tile-guests"
                label="Guests"
                value={now.guests_present}
                sub="Currently on campus"
                icon={UserCheck}
                tone={now.guests_present > 0 ? "violet" : "slate"}
                to="/presence"
              />
              <StatTile
                testid="dashboard-tile-escorts"
                label="Escorts"
                value={now.escorts_present}
                sub="Signed in today"
                icon={IdCard}
                tone={now.escorts_present > 0 ? "sky" : "slate"}
                to="/presence"
              />
              <StatTile
                testid="dashboard-tile-approvals"
                label="Pending approvals"
                value={now.pending_approvals.total}
                sub={`${now.pending_approvals.leaves} leaves · ${now.pending_approvals.overtime} OT · ${now.pending_approvals.devices} devices`}
                icon={ClipboardCheck}
                tone={now.pending_approvals.total > 0 ? "amber" : "slate"}
                to="/admin/approvals"
              />
            </div>

            {/* By-location strip */}
            {(now.on_campus_by_location || []).length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100" data-testid="dashboard-by-location">
                <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                  <MapPin size={12} /> On campus by location
                </div>
                <div className="flex flex-wrap gap-2">
                  {now.on_campus_by_location.map((loc) => (
                    <Link
                      key={loc.site_id || "__main__"}
                      to={`/presence?location=${encodeURIComponent(loc.site_name)}`}
                      className="group inline-flex items-center gap-2 pl-2 pr-3 h-8 rounded-full bg-slate-100 hover:bg-slate-200 transition text-sm"
                      data-testid={`dashboard-location-${loc.site_id || "main"}`}
                    >
                      <MapPin size={12} className="text-sky-600" />
                      <span className="text-slate-800 font-medium truncate max-w-[180px]">
                        {loc.site_name}
                      </span>
                      <span className="font-mono tabular-nums font-bold text-slate-900 bg-white rounded-full px-2 min-w-[24px] text-center text-xs">
                        {loc.count}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </SectionCard>

          {/* THIS WEEK */}
          <SectionCard
            title="This week"
            testid="dashboard-week"
            action={
              <span className="text-[11px] text-slate-400 tabular-nums">
                {fmtRange(week.start_date, week.end_date)}
              </span>
            }
          >
            <div className="grid md:grid-cols-2 gap-4">
              {/* Sparkline */}
              <div>
                <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                  <TrendingUp size={13} /> Daily attendance
                </div>
                <Sparkline points={week.sparkline} />
              </div>

              {/* Top late-comers */}
              <div data-testid="dashboard-top-late">
                <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                  <Clock size={13} /> Top 5 late-comers
                </div>
                {week.top_late.length === 0 ? (
                  <div className="text-xs text-slate-400 italic py-2">No late arrivals this week 🎉</div>
                ) : (
                  <ul className="space-y-1.5">
                    {week.top_late.map((m) => (
                      <li key={m.member_id} className="flex items-center gap-2 text-sm">
                        <Avatar name={m.name} photo={m.photo} size={28} />
                        <span className="flex-1 truncate text-slate-800">{m.name}</span>
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${CATEGORY_COLOR[m.category] || "bg-slate-100 text-slate-700"}`}
                        >
                          {m.category?.[0]?.toUpperCase() || "?"}
                        </span>
                        <span className="text-xs font-bold text-rose-600 tabular-nums">
                          {m.late_days}d
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Top OT this week — surfaces payroll pressure points +
                  possible burnout / data-entry errors. Double-click a
                  row to jump to that member's OT ledger. */}
              <div data-testid="dashboard-top-ot">
                <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                  <TrendingUp size={13} /> Top 5 OT this week
                </div>
                {(week.top_ot || []).length === 0 ? (
                  <div className="text-xs text-slate-400 italic py-2">No overtime this week.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {(week.top_ot || []).map((m) => {
                      const h = Math.floor((m.ot_minutes || 0) / 60);
                      const mm = (m.ot_minutes || 0) % 60;
                      const label = h > 0 ? (mm ? `${h}h ${mm}m` : `${h}h`) : `${mm}m`;
                      return (
                        <li
                          key={m.member_id}
                          className="flex items-center gap-2 text-sm"
                          data-testid={`dashboard-top-ot-row-${m.member_id}`}
                        >
                          <Avatar name={m.name} photo={m.photo} size={28} />
                          <span className="flex-1 truncate text-slate-800">{m.name}</span>
                          <span
                            className={`inline-flex px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${CATEGORY_COLOR[m.category] || "bg-slate-100 text-slate-700"}`}
                          >
                            {m.category?.[0]?.toUpperCase() || "?"}
                          </span>
                          <span className="text-xs font-bold text-violet-700 tabular-nums">
                            {label}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Birthdays */}
              <div data-testid="dashboard-birthdays">
                <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                  <Cake size={13} /> Birthdays this week
                </div>
                {week.birthdays.length === 0 ? (
                  <div className="text-xs text-slate-400 italic py-2">None this week.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {week.birthdays.map((b) => (
                      <li key={b.member_id + b.date_this_week} className="flex items-center gap-2 text-sm">
                        <Avatar name={b.name} photo={b.photo} size={28} />
                        <span className="flex-1 truncate text-slate-800">{b.name}</span>
                        <span className="text-xs text-slate-500 tabular-nums">
                          {fmtShortDate(b.date_this_week)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Camps & Regattas */}
              <div data-testid="dashboard-events">
                <div className="text-xs font-bold uppercase text-slate-500 mb-2 flex items-center gap-1.5">
                  <Trophy size={13} /> Camps & Regattas
                </div>
                {week.events.length === 0 ? (
                  <div className="text-xs text-slate-400 italic py-2">Nothing scheduled.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {week.events.map((e) => (
                      <li key={`${e.kind}-${e.id}`} className="flex items-center gap-2 text-sm">
                        {e.kind === "camp"
                          ? <Sailboat size={14} className="text-sky-500" />
                          : <Trophy size={14} className="text-amber-500" />}
                        <span className="flex-1 truncate text-slate-800">{e.name}</span>
                        <span className="text-xs text-slate-500 tabular-nums">
                          {fmtRange(e.start_date, e.end_date)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link
                  to="/admin/calendar"
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-700 hover:underline mt-2"
                >
                  Open calendar <ArrowRight size={11} />
                </Link>
              </div>
            </div>
          </SectionCard>

          {/* THIS MONTH */}
          <SectionCard
            title="This month"
            testid="dashboard-month"
            action={
              <span className="text-[11px] text-slate-400 tabular-nums">
                {fmtRange(month.start_date, month.end_date)}
              </span>
            }
          >
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile
                testid="dashboard-tile-staff-hours"
                label="Staff hours"
                value={month.staff_hours}
                sub="Coaches + staff + execs"
                icon={Clock}
                tone="sky"
                to="/admin/reports?tab=payroll"
              />
              <StatTile
                testid="dashboard-tile-ot-hours"
                label="Approved OT hrs"
                value={month.ot_hours}
                sub="Payroll-approved this month"
                icon={TrendingUp}
                tone="amber"
                to="/admin/approvals?tab=overtime"
              />
              <StatTile
                testid="dashboard-tile-leave-days"
                label="Leave days"
                value={month.leave_days_consumed}
                sub="Approved leave consumed"
                icon={CalendarIcon}
                tone="violet"
                to="/admin/leave-balances"
              />
              <StatTile
                testid="dashboard-tile-new-members"
                label="New members"
                value={month.new_members}
                sub="Joined this month"
                icon={Users}
                tone="emerald"
                to="/admin/members"
              />
            </div>
          </SectionCard>
        </div>

        {/* ── RIGHT RAIL: ATTENTION ────────────────────────── */}
        <aside className="space-y-5" data-testid="dashboard-attention">
          <SectionCard
            title="Attention"
            testid="dashboard-attention-card"
            action={
              <span
                className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${attentionTotal > 0 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}
              >
                {attentionTotal > 0 ? `${attentionTotal} items` : "All clear"}
              </span>
            }
          >
            <ul className="space-y-2 text-sm">
              <AttentionRow
                label="Pending leave requests"
                value={attention.pending_leaves}
                to="/admin/approvals?tab=leaves"
                testid="attention-leaves"
                tone="amber"
              />
              {/* Pending OT approvals row removed 15 Feb 2026 — OT is
                  now purely calculated, no approval queue. */}
              <AttentionRow
                label="Device access requests"
                value={attention.pending_devices}
                to="/admin/devices"
                testid="attention-devices"
                tone="sky"
              />
              <AttentionRow
                label="Open sessions >36h"
                value={attention.stale_sessions}
                to="/admin/data-quality"
                testid="attention-stale"
                tone="rose"
              />
              <AttentionRow
                label="Athletes w/o parent contact"
                value={attention.athletes_no_parent_contact}
                to="/admin/data-quality"
                testid="attention-noparent"
                tone="rose"
              />
            </ul>
          </SectionCard>

          <SectionCard title="Shortcuts" testid="dashboard-shortcuts">
            <div className="grid grid-cols-2 gap-2">
              <ShortcutBtn to="/presence" icon={Users} label="Presence" testid="shortcut-presence" />
              <ShortcutBtn to="/muster" icon={ClipboardCheck} label="Muster" testid="shortcut-muster" />
              <ShortcutBtn to="/admin/reports" icon={TrendingUp} label="The Grid" testid="shortcut-reports" />
              <ShortcutBtn to="/admin/data-quality" icon={ShieldAlert} label="Data quality" testid="shortcut-dq" />
              <ShortcutBtn to="/admin/audit-log" icon={ClipboardCheck} label="Audit log" testid="shortcut-audit" />
              <ShortcutBtn to="/admin/calendar" icon={CalendarIcon} label="Calendar" testid="shortcut-calendar" />
            </div>
          </SectionCard>

          <MonthCorrectionsCard />
        </aside>
      </div>
    </div>
  );
}

// ----- AttentionRow + ShortcutBtn moved to ./dashboard/widgets.jsx -
