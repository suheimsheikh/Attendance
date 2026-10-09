import React, { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "../../api";
import { categoryLabel, formatDate } from "../../utils";
import Avatar from "../../components/Avatar";

export const MemberProfilePicker = ({ selfId, targetId, targetName, onPick }) => {
  const [members, setMembers] = useState(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    api.get("/members").then(rows => {
      if (!cancelled) setMembers(Array.isArray(rows) ? rows : []);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [retry]);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members || []).filter(m => [m.full_name, m.category, m.rank, m.email, m.institution]
      .some(v => String(v || "").toLowerCase().includes(q)));
  }, [members, query]);
  const selected = members?.find(m => m.id === targetId);
  return (
    <section className="border-b border-slate-200 pb-4 space-y-2" data-testid="admin-profile-search-card">
      <label htmlFor="profile-member-search" className="iu-label flex items-center gap-2">
        <Search size={14}/> Member profile · Staff & athletes
      </label>
      <div className="relative">
        <input id="profile-member-search" data-testid="admin-profile-member-search" className="iu-input w-full"
          autoComplete="off" value={query} placeholder="Search by name, category, rank, institution or email…"
          onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}
          onBlur={e => { if (!e.currentTarget.parentElement.contains(e.relatedTarget)) setOpen(false); }}/>
        {open && <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg"
          data-testid="admin-profile-search-results" onBlur={e => { if (!e.currentTarget.parentElement.contains(e.relatedTarget)) setOpen(false); }}>
          {error ? <div className="p-3 text-sm text-red-700" role="alert" data-testid="profile-member-search-error">
            Could not load members. <button title="Try again" className="underline" data-testid="profile-member-search-retry" onClick={() => setRetry(n => n + 1)}>Retry</button>
          </div> : !members ? <p className="p-3 text-sm" data-testid="profile-member-search-loading">Loading members…</p>
            : results.length === 0 ? <p className="p-3 text-sm" data-testid="profile-member-search-empty">No matching members.</p>
              : results.map(m => <button key={m.id} type="button" data-testid={`admin-profile-search-pick-${m.id}`}
                onMouseDown={e => e.preventDefault()} onClick={() => { onPick(m.id); setQuery(""); setOpen(false); }}
                className="w-full px-3 py-2.5 flex items-center gap-2 text-left hover:bg-sky-50 focus:bg-sky-50 transition-colors border-b border-slate-100">
                <Avatar name={m.full_name} photo={m.photo} size={28}/>
                <span className="min-w-0 flex-1 break-words text-sm"><b>{m.full_name}</b>
                  <span className="block text-xs text-slate-500">{[categoryLabel(m.category), m.rank, m.institution, m.leaving_date ? `Left ${formatDate(m.leaving_date)}` : null].filter(Boolean).join(" · ")}</span>
                </span>
              </button>)}
        </div>}
      </div>
      {targetId && targetId !== selfId && <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold break-words" data-testid="admin-profile-search-current">{selected?.full_name || targetName || "Selected member"}</span>
        <button className="iu-btn-secondary !h-8 !px-2" data-testid="admin-profile-search-clear"
          onClick={() => { onPick(null); setQuery(""); setOpen(false); }}><X size={12}/> Back to my profile</button>
      </div>}
    </section>
  );
};