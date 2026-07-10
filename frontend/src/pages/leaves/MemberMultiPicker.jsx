/**
 * MemberMultiPicker — the admin "Pick members" block used by the
 * apply-on-behalf leave form. Search + institution filter + checkbox
 * list + auto-approve toggle. Pure presentational — all state lives
 * in the parent (ApplyForm).
 *
 * Extracted from MyLeaves.jsx on 15 Feb 2026 as part of the split
 * of the 637-line ApplyForm.
 */
import React from "react";
import { Search, Check } from "lucide-react";
import Avatar from "../../components/Avatar";

export default function MemberMultiPicker({
  members,          // filtered member list already resolved by parent
  institutions,     // [{id, name}, ...]
  instFilter,       // "" for all, else institution name
  onInstFilter,     // (v: string) => void
  search,           // current search string
  onSearch,         // (v: string) => void
  picked,           // Set<string> — currently picked ids
  onTogglePick,     // (id: string) => void
  onPickAllFiltered,
  onClearPicked,
  autoApprove,
  onAutoApprove,    // (b: boolean) => void
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="iu-label !mb-0">Pick members ({picked.size} selected)</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onPickAllFiltered}
            data-testid="ob-pick-all"
            className="iu-btn-secondary !h-8 !px-2 !text-xs"
          >Pick all ({members.length})</button>
          <button
            type="button"
            onClick={onClearPicked}
            data-testid="ob-clear"
            className="iu-btn-secondary !h-8 !px-2 !text-xs"
            disabled={picked.size === 0}
          >Clear</button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 flex items-center gap-2 px-2 h-9 rounded-lg border border-slate-200 bg-white">
          <Search size={14} className="text-slate-400" />
          <input
            data-testid="ob-search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name, rank or email…"
            className="flex-1 outline-none bg-transparent text-sm"
          />
        </div>
        <select
          data-testid="ob-inst-filter"
          value={instFilter}
          onChange={(e) => onInstFilter(e.target.value)}
          className="iu-input !h-9 !w-44"
        >
          <option value="">All institutions</option>
          {institutions.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
        </select>
      </div>
      <div
        className="bg-white rounded-lg border border-slate-200 max-h-[34vh] overflow-auto divide-y divide-slate-100"
        data-testid="ob-member-list"
      >
        {members.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">No members match.</div>
        ) : members.map((m) => {
          const on = picked.has(m.id);
          return (
            <label
              key={m.id}
              className={`px-3 py-2 flex items-center gap-3 cursor-pointer transition ${on ? "bg-emerald-50/70" : "hover:bg-slate-50"}`}
              data-testid={`ob-row-${m.id}`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onTogglePick(m.id)}
                data-testid={`ob-checkbox-${m.id}`}
              />
              <Avatar name={m.full_name} photo={m.photo} size={28} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-slate-900 truncate">{m.full_name}</div>
                <div className="text-[11px] text-slate-500 truncate">
                  {m.rank ? `${m.rank} · ` : ""}{m.institution || "—"}
                </div>
              </div>
              {on && <Check size={14} className="text-emerald-600" />}
            </label>
          );
        })}
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
        <input
          type="checkbox"
          checked={autoApprove}
          onChange={(e) => onAutoApprove(e.target.checked)}
          data-testid="ob-auto-approve"
        />
        Auto-approve (skip the pending queue)
      </label>
    </div>
  );
}
