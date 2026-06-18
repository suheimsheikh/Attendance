import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Users, Bed, Plane, RefreshCw, Clock, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import { todayIso } from "../../utils";

const TYPE_OPTS = [
  { key: "leave",       label: "Leave",        Icon: Bed,       color: "#F59E0B" },
  { key: "tour",        label: "Tour",         Icon: Plane,     color: "#F97316" },
  { key: "comp_off",    label: "Comp Off",     Icon: RefreshCw, color: "#8B5CF6" },
  { key: "late_coming", label: "Late Coming",  Icon: Clock,     color: "#DC2626" },
];

export default function GroupLeave() {
  const [members, setMembers] = useState([]);
  const [institutions, setInstitutions] = useState([]);
  const [instFilter, setInstFilter] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(new Set());

  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/members").then(setMembers).catch(() => {});
    api.get("/institutions").then((r) => setInstitutions(r || [])).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (instFilter && m.institution !== instFilter) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q) ||
             (m.rank || "").toLowerCase().includes(q);
    });
  }, [members, search, instFilter]);

  const toggle = (id) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const pickAllFiltered = () => setPicked(new Set(filtered.map((m) => m.id)));
  const clearAll = () => setPicked(new Set());

  const submit = async () => {
    if (picked.size === 0) { toast.error("Pick at least one member"); return; }
    if (!reason.trim()) { toast.error("Enter a reason"); return; }
    if (end < start) { toast.error("End date must be on/after start"); return; }
    setBusy(true);
    try {
      const r = await api.post("/leaves/group", {
        user_ids: [...picked], type,
        start_date: start, end_date: end,
        reason: reason.trim(),
        location: type === "tour" ? location : null,
        auto_approve: autoApprove,
      });
      toast.success(`${r.created} ${r.created === 1 ? "request" : "requests"} created (${r.status})`);
      setPicked(new Set());
      setReason("");
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Group Leave</h1>
        <p className="text-slate-500 text-sm mt-1">File the same leave/tour/comp-off for an entire group in one go.</p>
      </header>

      <div className="iu-card p-4 mb-4 space-y-3">
        <div>
          <label className="iu-label">Type</label>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {TYPE_OPTS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setType(t.key)}
                className={`iu-btn ${type === t.key ? "iu-btn-primary" : "iu-btn-secondary"}`}
                data-testid={`gl-type-${t.key}`}
              >
                <t.Icon size={16} /> {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">From</label>
            <input data-testid="gl-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">To</label>
            <input data-testid="gl-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="iu-input" />
          </div>
        </div>
        {type === "tour" && (
          <div>
            <label className="iu-label">Location</label>
            <input data-testid="gl-location" value={location} onChange={(e) => setLocation(e.target.value)} className="iu-input" placeholder="e.g. Sailing Nationals, Mumbai" />
          </div>
        )}
        <div>
          <label className="iu-label">Reason</label>
          <textarea data-testid="gl-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Semester break · Inter-school tournament" className="iu-input !h-auto py-2" />
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} data-testid="gl-auto-approve" />
          Auto-approve (skip the pending queue)
        </label>
      </div>

      <div className="iu-card p-3 mb-3 flex items-center gap-3">
        <Search size={16} className="text-slate-400" />
        <input
          data-testid="gl-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or rank…"
          className="flex-1 outline-none bg-transparent text-sm"
        />
        <select data-testid="gl-inst-filter" value={instFilter} onChange={(e) => setInstFilter(e.target.value)} className="iu-input !h-9 !w-auto">
          <option value="">All institutions</option>
          {institutions.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
        </select>
        <button onClick={pickAllFiltered} className="iu-btn-secondary !h-9 !px-3" data-testid="gl-pick-all">Pick all ({filtered.length})</button>
        <button onClick={clearAll} className="iu-btn-secondary !h-9 !px-3" data-testid="gl-clear">Clear</button>
      </div>

      <div className="iu-card overflow-hidden mb-4">
        <div className="overflow-auto max-h-[42vh] divide-y divide-slate-100">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-500">No members match.</div>
          ) : filtered.map((m) => {
            const on = picked.has(m.id);
            return (
              <div
                key={m.id}
                onClick={() => toggle(m.id)}
                className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer transition ${on ? "bg-emerald-50/70" : "hover:bg-slate-50"}`}
                data-testid={`gl-row-${m.id}`}
              >
                <input type="checkbox" checked={on} onChange={() => toggle(m.id)} onClick={(e) => e.stopPropagation()} />
                <Avatar name={m.full_name} photo={m.photo} size={32} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-slate-900 truncate">{m.full_name}</div>
                  <div className="text-xs text-slate-500 truncate">{m.rank ? `${m.rank} · ` : ""}{m.institution || "—"}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="sticky bottom-3 iu-card p-3 flex items-center gap-3">
        <Users size={18} className="text-slate-500" />
        <div className="flex-1 text-sm" data-testid="gl-summary">
          <strong>{picked.size}</strong> selected · {type} from {start} to {end}
        </div>
        <button onClick={submit} disabled={busy || picked.size === 0} className="iu-btn-primary" data-testid="gl-submit">
          {busy ? <Loader2 className="animate-spin" size={14}/> : "Create group leave"}
        </button>
      </div>
    </div>
  );
}
