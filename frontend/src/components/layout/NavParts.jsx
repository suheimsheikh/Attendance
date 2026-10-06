import React from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";

export function SystemGroup({ label, tone = "cyan", icon: Icon, open, onToggle, count, children }) {
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

export function NavItem({ to, label, icon: Icon, end, onClick, onHoverPrefetch, disabled, disabledReason, highlight, badge, hint }) {
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
