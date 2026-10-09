import React, { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "../../../api";
import { isExMember } from "../../../utils/exMember";

// Pick any active members (athletes, coaches, staff, custom) for a regatta team.
export default function TeamPicker({ value, onChange }) {
  const [members, setMembers] = useState([]);
  const [q, setQ] = useState("");
  useEffect(() => { api.get("/members").then((m) => setMembers(m || [])).catch(() => {}); }, []);
  const active = useMemo(() => members.filter((m) => !m.archived && m.active !== false && !isExMember(m)), [members]);
  const byId = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);
  const cat = (m) => m.custom_category || m.category || "";
  const shown = active
    .filter((m) => !q || `${m.full_name} ${cat(m)}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => cat(a).localeCompare(cat(b)) || (a.full_name || "").localeCompare(b.full_name || ""));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div data-testid="team-picker">
      <div className="flex flex-wrap gap-1.5 mb-2" data-testid="team-selected">
        {value.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 bg-sky-100 text-sky-800 text-xs font-semibold rounded-full pl-2 pr-1 py-0.5">
            {byId[id]?.full_name || "Unknown"}
            <button type="button" onClick={() => toggle(id)} title="Remove from team" data-testid={`team-chip-remove-${id}`}><X size={12} /></button>
          </span>
        ))}
        {!value.length && <span className="text-xs text-slate-400">No one picked yet</span>}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or category…" className="iu-input mb-2" data-testid="team-search" />
      <div className="max-h-56 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {shown.map((m) => (
          <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-slate-50" data-testid={`team-opt-${m.id}`}>
            <input type="checkbox" checked={value.includes(m.id)} onChange={() => toggle(m.id)} data-testid={`team-check-${m.id}`} />
            <span className="font-medium">{m.full_name}</span>
            <span className="ml-auto text-[11px] text-slate-500 capitalize">{cat(m)}</span>
          </label>
        ))}
        {!shown.length && <div className="p-4 text-center text-xs text-slate-400">No matching members</div>}
      </div>
      <div className="text-xs text-slate-500 mt-1" data-testid="team-count">{value.length} selected</div>
    </div>
  );
}
