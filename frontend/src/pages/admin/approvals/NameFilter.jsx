import React from "react";
import { Search, X } from "lucide-react";

// Type-ahead name filter: free text plus a dropdown of everyone in the lists.
export default function NameFilter({ value, onChange, names }) {
  return (
    <div className="relative" data-testid="approvals-name-filter">
      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
      <input list="approvals-names" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Filter by name…"
        className="iu-input !pl-8 !pr-7 !w-60 !h-9" data-testid="approvals-name-input" title="Type or pick a member to show only their requests" />
      <datalist id="approvals-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      {value && (
        <button type="button" onClick={() => onChange("")} title="Clear name filter" data-testid="approvals-name-clear"
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"><X size={14} /></button>
      )}
    </div>
  );
}
