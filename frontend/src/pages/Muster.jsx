import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Loader2, Search, RefreshCw, CheckSquare, Square, LogIn, LogOut as LogOutIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import Avatar from "../components/Avatar";
import { useAuth } from "../auth";

const MODES = [
  { key: "checkin",  label: "Check in",  Icon: LogIn,        verb: "Check in",  color: "#10B981" },
  { key: "checkout", label: "Check out", Icon: LogOutIcon,   verb: "Check out", color: "#6B7280" },
];

export default function Muster() {
  const { user } = useAuth();
  const [mode, setMode] = useState("checkin");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [saving, setSaving] = useState(false);

  const meta = MODES.find((m) => m.key === mode);
  const [institutionFilter, setInstitutionFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/muster/sailors", { mode });
      setData(res);
      setPicked(new Set());
    } catch (err) {
      toast.error(err?.message || "Couldn't load roster");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => { load(); }, [load]);
  // Reset institution filter when mode changes so the user always starts broad.
  useEffect(() => { setInstitutionFilter("all"); }, [mode]);

  // Distinct institutions present in the current roster (sorted, "(none)" last).
  const institutions = useMemo(() => {
    const set = new Map();  // name -> count
    (data?.sailors || []).forEach((s) => {
      const k = s.institution || "(no institution)";
      set.set(k, (set.get(k) || 0) + 1);
    });
    const arr = Array.from(set.entries()).map(([name, count]) => ({ name, count }));
    arr.sort((a, b) => {
      if (a.name === "(no institution)") return 1;
      if (b.name === "(no institution)") return -1;
      return a.name.localeCompare(b.name);
    });
    return arr;
  }, [data]);

  const filtered = useMemo(() => {
    const list = data?.sailors || [];
    const q = search.trim().toLowerCase();
    return list.filter((s) => {
      if (institutionFilter !== "all") {
        const sInst = s.institution || "(no institution)";
        if (sInst !== institutionFilter) return false;
      }
      if (!q) return true;
      return (
        (s.full_name || "").toLowerCase().includes(q) ||
        (s.rank || "").toLowerCase().includes(q) ||
        (s.institution || "").toLowerCase().includes(q)
      );
    });
  }, [data, search, institutionFilter]);

  const toggle = (id) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const toggleAllVisible = () => {
    const next = new Set(picked);
    const allPicked = filtered.every((s) => next.has(s.id));
    if (allPicked) filtered.forEach((s) => next.delete(s.id));
    else filtered.forEach((s) => next.add(s.id));
    setPicked(next);
  };

  const submit = async () => {
    if (picked.size === 0) {
      toast.error("Tick at least one sailor first");
      return;
    }
    setSaving(true);
    try {
      const endpoint = mode === "checkin" ? "/muster/checkin-bulk" : "/muster/checkout-bulk";
      const res = await api.post(endpoint, { sailor_ids: Array.from(picked) });
      const doneCount = res.checked_in_count ?? res.checked_out_count ?? 0;
      const skipCount = res.skipped_count ?? 0;
      const skipNote = skipCount > 0 ? ` · ${skipCount} skipped` : "";
      toast.success(
        mode === "checkin"
          ? `${doneCount} sailor${doneCount === 1 ? "" : "s"} marked present${skipNote}`
          : `${doneCount} sailor${doneCount === 1 ? "" : "s"} marked departed${skipNote}`
      );
      load();
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const allVisiblePicked = filtered.length > 0 && filtered.every((s) => picked.has(s.id));

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto pb-32" data-testid="muster-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Muster Roll</h1>
        <p className="text-slate-500 text-sm mt-1">
          Tick the sailors who are physically present. Their attendance is logged with your name as the verifier.
        </p>
      </header>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {MODES.map((m) => (
          <button
            key={m.key}
            data-testid={`muster-mode-${m.key}`}
            onClick={() => setMode(m.key)}
            className={`iu-btn ${mode === m.key ? "iu-btn-primary" : "iu-btn-secondary"}`}
          >
            <m.Icon size={16} /> {m.label}
          </button>
        ))}
      </div>

      {/* Institution filter chips */}
      {institutions.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1"
          data-testid="muster-institution-filter"
        >
          <button
            data-testid="muster-institution-all"
            onClick={() => setInstitutionFilter("all")}
            className={`iu-chip whitespace-nowrap shrink-0 ${institutionFilter === "all" ? "iu-chip-active" : ""}`}
          >
            All
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${institutionFilter === "all" ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
              {(data?.sailors || []).length}
            </span>
          </button>
          {institutions.map((inst) => {
            const active = institutionFilter === inst.name;
            return (
              <button
                key={inst.name}
                data-testid={`muster-institution-${inst.name.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => setInstitutionFilter(inst.name)}
                className={`iu-chip whitespace-nowrap shrink-0 ${active ? "iu-chip-active" : ""}`}
              >
                {inst.name}
                <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
                  {inst.count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search + bulk-tick */}
      <div className="iu-card p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[180px]">
          <Search size={18} className="text-slate-400" />
          <input
            data-testid="muster-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter sailors by name or rank…"
            className="flex-1 outline-none bg-transparent text-sm"
          />
        </div>
        <button
          data-testid="muster-toggle-all"
          onClick={toggleAllVisible}
          disabled={filtered.length === 0}
          className="iu-btn-ghost !h-9 !px-3 text-xs"
        >
          {allVisiblePicked ? <CheckSquare size={14}/> : <Square size={14}/>}
          {allVisiblePicked ? "Untick visible" : "Tick all visible"}
        </button>
        <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="muster-refresh">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Summary line */}
      <div className="flex items-baseline justify-between mb-2 px-1">
        <p className="text-sm text-slate-600" data-testid="muster-summary">
          <span className="font-bold text-slate-900">{filtered.length}</span> sailor{filtered.length === 1 ? "" : "s"} {mode === "checkin" ? "to check in" : "still on campus"}
          {picked.size > 0 && (
            <> · <span className="font-bold text-emerald-700">{picked.size}</span> ticked</>
          )}
        </p>
        <p className="text-xs text-slate-400">{data?.date}</p>
      </div>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="muster-empty">
          <Users className="mx-auto text-slate-300 mb-2" size={36} />
          <p className="font-semibold text-slate-700">
            {mode === "checkin" ? "Everyone's already accounted for" : "Nobody is currently on campus"}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {mode === "checkin"
              ? "All sailors are either already checked in, on leave, or have completed their day."
              : "There's nobody to check out right now."}
          </p>
        </div>
      ) : (
        <ul className="iu-card divide-y divide-slate-100 overflow-hidden" data-testid="muster-list">
          {filtered.map((s) => {
            const isPicked = picked.has(s.id);
            return (
              <li
                key={s.id}
                onClick={() => toggle(s.id)}
                className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition ${isPicked ? "bg-emerald-50" : "hover:bg-slate-50"}`}
                data-testid={`muster-row-${s.id}`}
              >
                <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${isPicked ? "bg-emerald-600 border-emerald-600 text-white" : "border-slate-300"}`}>
                  {isPicked && <CheckSquare size={14}/>}
                </div>
                <Avatar name={s.full_name} photo={s.photo} size={38} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-slate-900 truncate">{s.full_name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {s.rank ? `${s.rank} · ` : ""}
                    {s.institution || (s.rank ? "" : "—")}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 md:left-64 bg-white border-t border-slate-200 p-3 md:p-4 z-40">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="flex-1 text-sm">
            {picked.size === 0
              ? <span className="text-slate-400">Tick sailors above to {meta.verb.toLowerCase()}</span>
              : <span className="font-semibold text-slate-900">{picked.size} ticked</span>}
            {user?.full_name && (
              <span className="text-xs text-slate-400 block">Verified by {user.full_name}</span>
            )}
          </div>
          <button
            data-testid="muster-submit"
            onClick={submit}
            disabled={saving || picked.size === 0}
            className="iu-btn-primary"
            style={{ background: picked.size > 0 ? meta.color : undefined }}
          >
            {saving ? <Loader2 className="animate-spin" size={16}/> : <meta.Icon size={16}/>}
            {meta.verb} {picked.size > 0 ? picked.size : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
