/**
 * MemberBucketFilters — rewritten 20 Feb 2026 after repeated reports
 * that the previous version was "grossly dysfunctional" (crashes,
 * inconsistent counts, sticky selection state).
 *
 * Design principles this time:
 *   • Everything is a plain <button> with an aria-pressed state
 *   • Only ONE bucket can be active at a time (radio-ish behaviour)
 *   • Admin / Chef role toggles are ORTHOGONAL and independent
 *   • Institution + search are handled by the parent, we only receive
 *     the display counts so the pill numbers can't lie
 *   • A "Clear filters" pill appears the moment anything is on
 */
import React from "react";
import { X } from "lucide-react";
import { BUCKETS, BUCKET_BY_KEY } from "./helpers";

export default function MemberBucketFilters({
  bucket, onBucketChange,
  counts,
  onlyAdmins, onAdminToggle,
  onlyChefs, onChefToggle,
  institutions, instFilter, onInstFilterChange,
  anyFilterOn, onClearFilters,
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="member-filters">
      {BUCKETS.map((b) => {
        const active = bucket === b.key;
        return (
          <button
            key={b.key}
            type="button"
            aria-pressed={active}
            onClick={() => onBucketChange(b.key)}
            data-testid={`bucket-${b.key}`}
            className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs font-bold border transition ${
              active
                ? `${b.activeBg} ${b.activeText} border-transparent shadow-sm`
                : `${b.inactiveBg} ${b.inactiveText} ${b.inactiveBorder} hover:brightness-95`
            }`}
          >
            {b.key !== "all" && <span className={`inline-block w-1.5 h-1.5 rounded-full ${b.dotBg}`} />}
            {b.label}
            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
              active ? "bg-white/25" : "bg-white text-slate-700 border border-slate-200"
            }`}>{counts[b.key] ?? 0}</span>
          </button>
        );
      })}

      <span className="mx-1 h-4 w-px bg-slate-200" />

      <button
        type="button"
        aria-pressed={onlyAdmins}
        onClick={onAdminToggle}
        data-testid="bucket-admin"
        className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs font-bold border transition ${
          onlyAdmins
            ? "bg-slate-900 text-white border-transparent shadow-sm"
            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
        }`}
      >
        Admin role
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
          onlyAdmins ? "bg-white/25" : "bg-slate-100 text-slate-700"
        }`}>{counts.admin ?? 0}</span>
      </button>

      <button
        type="button"
        aria-pressed={onlyChefs}
        onClick={onChefToggle}
        data-testid="bucket-chef"
        className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-xs font-bold border transition ${
          onlyChefs
            ? "bg-orange-600 text-white border-transparent shadow-sm"
            : "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100"
        }`}
      >
        Chef role
        <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-black tabular-nums ${
          onlyChefs ? "bg-white/25" : "bg-white text-orange-700 border border-orange-200"
        }`}>{counts.chef ?? 0}</span>
      </button>

      {institutions && institutions.length > 0 && (
        <>
          <span className="mx-1 h-4 w-px bg-slate-200" />
          <select
            value={instFilter || ""}
            onChange={(e) => onInstFilterChange(e.target.value)}
            data-testid="member-inst-filter"
            className={`h-7 rounded-full text-xs font-semibold border px-2.5 transition ${
              instFilter
                ? "bg-indigo-600 text-white border-transparent"
                : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
            }`}
            title="Filter by institution"
          >
            <option value="">All institutions</option>
            {institutions.map((i) => {
              // Accept both raw strings AND institution masters {id, name, …}.
              // The filter compares against user.institution which is a name string.
              const name = typeof i === "string" ? i : (i?.name || "");
              if (!name) return null;
              return <option key={name} value={name}>{name}</option>;
            })}
          </select>
        </>
      )}

      {anyFilterOn && (
        <button
          type="button"
          onClick={onClearFilters}
          data-testid="member-clear-filters"
          title="Reset every filter to its default"
          className="inline-flex items-center gap-1 px-2.5 h-7 rounded-full text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 transition ml-auto"
        >
          <X size={12}/> Clear filters
        </button>
      )}
    </div>
  );
}

// Re-export in case another view still imports it from here.
export { BUCKETS, BUCKET_BY_KEY };
