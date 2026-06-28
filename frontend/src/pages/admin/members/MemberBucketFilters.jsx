import React from "react";
import { ShieldCheck } from "lucide-react";
import { BUCKETS } from "./helpers";

/**
 * MemberBucketFilters — the row of category-chip filters (All / Coaches /
 * Staff / Executives / Athletes), an orthogonal "Admin role" toggle, and
 * an Institution dropdown.
 *
 * Extracted from Members.jsx so the parent stays focused on data ops.
 * All state is owned by the parent; this component is pure presentation
 * driven by props.
 */
export default function MemberBucketFilters({
  bucket,
  onBucketChange,
  counts,
  onlyAdmins,
  onAdminToggle,
  institutions,
  instFilter,
  onInstFilterChange,
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-3" data-testid="member-bucket-filters">
      {BUCKETS.map((b) => {
        const active = bucket === b.key;
        const n = counts[b.key] ?? 0;
        const cls = active
          ? `${b.activeBg} ${b.activeText} border-transparent`
          : `${b.inactiveBg} ${b.inactiveText} ${b.inactiveBorder}`;
        return (
          <button
            key={b.key}
            data-testid={`bucket-${b.key}`}
            onClick={() => onBucketChange(b.key)}
            className={`inline-flex items-center gap-2 px-3 h-8 rounded-full text-xs font-semibold border transition ${cls}`}
          >
            <span className={`w-2 h-2 rounded-full ${b.dotBg}`} />
            {b.label}
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{n}</span>
          </button>
        );
      })}
      {/* Orthogonal "Admin role" toggle. Combines with the category filter
          above — e.g. Coaches + Admins shows only coaches who are admins. */}
      <button
        data-testid="bucket-admin"
        onClick={onAdminToggle}
        className={`inline-flex items-center gap-2 px-3 h-8 rounded-full text-xs font-semibold border transition ${
          onlyAdmins
            ? "bg-indigo-600 text-white border-transparent"
            : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
        }`}
        title="Filter to members with the admin role (orthogonal — combines with category)"
      >
        <ShieldCheck size={13} />
        Admin role
        <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${onlyAdmins ? "bg-white/20 text-white" : "bg-white border border-indigo-200 text-indigo-700"}`}>
          {counts.admin}
        </span>
      </button>
      {institutions.length > 0 && (
        <select
          data-testid="member-inst-filter"
          value={instFilter}
          onChange={(e) => onInstFilterChange(e.target.value)}
          className="ml-auto h-8 px-3 rounded-full text-xs font-semibold border border-slate-200 bg-white text-slate-700"
        >
          <option value="">All institutions</option>
          {institutions.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
        </select>
      )}
    </div>
  );
}
