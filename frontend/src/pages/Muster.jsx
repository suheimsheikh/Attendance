import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Loader2, Search, RefreshCw, CheckSquare, Square, LogIn, LogOut as LogOutIcon, Users, Camera } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import Avatar from "../components/Avatar";
import ParentContact from "../components/ParentContact";
import { useAuth } from "../auth";
import SelfieCapture from "../components/SelfieCapture";

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
  const [photoTarget, setPhotoTarget] = useState(null); // {id, full_name}
  // Queue of athlete IDs to capture photos for *before* submitting the muster.
  // Each capture or skip pops the next; once empty we run the bulk endpoint.
  const [photoQueue, setPhotoQueue] = useState([]);

  const meta = MODES.find((m) => m.key === mode);
  const [institutionFilter, setInstitutionFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/muster/athletes", { mode });
      setData(res);
      setPicked(new Set());
    } catch (err) {
      showApiError(err, "Couldn't load roster");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => { load(); }, [load]);
  // Reset institution filter when mode changes so the user always starts broad.
  useEffect(() => { setInstitutionFilter("all"); }, [mode]);

  const runBulk = useCallback(async (ids) => {
    setSaving(true);
    try {
      const endpoint = mode === "checkin" ? "/muster/checkin-bulk" : "/muster/checkout-bulk";
      const res = await api.post(endpoint, { athlete_ids: ids });
      const doneCount = res.checked_in_count ?? res.checked_out_count ?? 0;
      const skipCount = res.skipped_count ?? 0;
      const skipNote = skipCount > 0 ? ` · ${skipCount} skipped` : "";
      toast.success(
        mode === "checkin"
          ? `${doneCount} athlete${doneCount === 1 ? "" : "s"} marked present${skipNote}`
          : `${doneCount} athlete${doneCount === 1 ? "" : "s"} marked departed${skipNote}`
      );
      // Clear the ticked set so the next round starts fresh (the just-saved
      // members no longer appear in the picker anyway, but state was lingering).
      setPicked(new Set());
      load();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally {
      setSaving(false);
    }
  }, [mode, load]);

  // Step through the photo queue: open the next missing-photo athlete in the
  // selfie modal until empty, then submit the muster bulk endpoint.
  const advancePhotoQueue = useCallback((queue) => {
    if (queue.length === 0) {
      setPhotoTarget(null);
      setPhotoQueue([]);
      // queue exhausted — submit the actual muster now with the originally
      // picked IDs (which we read from state at the moment of submit).
      runBulk(Array.from(picked));
      return;
    }
    const next = queue[0];
    setPhotoTarget({ id: next.id, full_name: next.full_name, queued: true });
    setPhotoQueue(queue);
  }, [picked, runBulk]);

  const savePhoto = async (dataUrl) => {
    if (!photoTarget) return;
    try {
      await api.post(`/members/${photoTarget.id}/photo`, { photo: dataUrl });
      toast.success(`Photo saved for ${photoTarget.full_name}`);
      setData((d) => d ? {
        ...d,
        athletes: d.athletes.map((a) => a.id === photoTarget.id ? { ...a, photo: dataUrl } : a),
      } : d);
    } catch (err) {
      showApiError(err, "Failed to save photo");
      return;
    }
    if (photoTarget.queued) {
      advancePhotoQueue(photoQueue.slice(1));
    } else {
      setPhotoTarget(null);
      load();
    }
  };

  const skipPhoto = () => {
    if (photoTarget?.queued) {
      advancePhotoQueue(photoQueue.slice(1));
    } else {
      setPhotoTarget(null);
    }
  };

  // Distinct institutions present in the current roster (sorted, "(none)" last).
  const institutions = useMemo(() => {
    const set = new Map();  // name -> count
    (data?.athletes || []).forEach((s) => {
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
    const list = data?.athletes || [];
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
    // Already-checked-in athletes (mode=checkin) are read-only. Server
    // also blocks the double check-in, but disabling the row keeps the
    // UI honest so the coach can see who's present without accidentally
    // re-ticking them.
    const a = (data?.athletes || []).find((x) => x.id === id);
    if (mode === "checkin" && a?.already_checked_in) return;
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  // Helper — filter list with the "tickable" rows only (excludes the
  // greyed-out already-checked-in rows in check-in mode).
  const tickable = useMemo(
    () => filtered.filter((s) => !(mode === "checkin" && s.already_checked_in)),
    [filtered, mode],
  );

  // Per-bucket breakdown over the *filtered* list — drives the sticky
  // breakdown bar above the muster list. Mirrors Presence's column
  // breakdown row. Athletes are a single category, so the chips here
  // pivot on gender + status (the ones a coach actually cares about
  // when running muster).
  const breakdown = useMemo(() => {
    let boys = 0, girls = 0, other = 0, lockedIn = 0;
    for (const a of filtered) {
      const g = (a.gender || "").toLowerCase();
      if (g === "male" || g === "boy" || g === "m") boys += 1;
      else if (g === "female" || g === "girl" || g === "f") girls += 1;
      else other += 1;
      if (mode === "checkin" && a.already_checked_in) lockedIn += 1;
    }
    return { boys, girls, other, lockedIn, total: filtered.length };
  }, [filtered, mode]);

  const toggleAllVisible = () => {
    const next = new Set(picked);
    const allPicked = tickable.length > 0 && tickable.every((s) => next.has(s.id));
    if (allPicked) tickable.forEach((s) => next.delete(s.id));
    else tickable.forEach((s) => next.add(s.id));
    setPicked(next);
  };

  const submit = async () => {
    if (picked.size === 0) {
      toast.error("Tick at least one athlete first");
      return;
    }
    // Only prompt for photos on check-IN (during muster the coach has the
    // athlete in front of them). Check-OUT skips this — most go home in groups
    // and we don't want to slow that down.
    const missing = mode === "checkin"
      ? (data?.athletes || []).filter((a) => picked.has(a.id) && !a.photo)
      : [];
    if (missing.length > 0) {
      advancePhotoQueue(missing);
      return;
    }
    runBulk(Array.from(picked));
  };

  const allVisiblePicked = tickable.length > 0 && tickable.every((s) => picked.has(s.id));

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto pb-32" data-testid="muster-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Muster Roll</h1>
        <p className="text-slate-500 text-sm mt-1">
          Tick the athletes who are physically present. Their attendance is logged with your name as the verifier.
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
              {(data?.athletes || []).length}
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
            placeholder="Filter athletes by name or rank…"
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
          <span className="font-bold text-slate-900">{tickable.length}</span> athlete{tickable.length === 1 ? "" : "s"} {mode === "checkin" ? "to check in" : "still on campus"}
          {mode === "checkin" && (filtered.length - tickable.length) > 0 && (
            <> · <span className="text-slate-500">{filtered.length - tickable.length} already in</span></>
          )}
          {picked.size > 0 && (
            <> · <span className="font-bold text-emerald-700">{picked.size}</span> ticked</>
          )}
        </p>
        <p className="text-xs text-slate-400">{data?.date}</p>
      </div>

      {/* Sticky breakdown bar — mirrors the per-category chip row on
          Presence columns. Stays visible while the list scrolls so the
          coach always sees the gender split + locked count of the
          currently filtered set. Hidden when the filter resolves to
          zero athletes (the muster-empty card takes over). */}
      {filtered.length > 0 && (
        <div
          className="sticky top-0 z-10 -mx-1 px-1 py-2 mb-2 bg-white/95 backdrop-blur border-y border-slate-200 flex items-center gap-1.5 flex-wrap"
          data-testid="muster-breakdown"
        >
          <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mr-1">
            Breakdown
          </span>
          {breakdown.boys > 0 && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-sky-100 text-sky-700"
              data-testid="muster-breakdown-boys"
              title={`${breakdown.boys} boys`}
            >
              B {breakdown.boys}
            </span>
          )}
          {breakdown.girls > 0 && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-pink-100 text-pink-700"
              data-testid="muster-breakdown-girls"
              title={`${breakdown.girls} girls`}
            >
              G {breakdown.girls}
            </span>
          )}
          {breakdown.other > 0 && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-slate-100 text-slate-700"
              data-testid="muster-breakdown-other"
              title={`${breakdown.other} unspecified gender`}
            >
              ◇ {breakdown.other}
            </span>
          )}
          {mode === "checkin" && breakdown.lockedIn > 0 && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-700"
              data-testid="muster-breakdown-locked"
              title={`${breakdown.lockedIn} already checked in`}
            >
              ✓ {breakdown.lockedIn} in
            </span>
          )}
          {picked.size > 0 && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-emerald-600 text-white ml-auto"
              data-testid="muster-breakdown-picked"
              title={`${picked.size} ticked`}
            >
              ☑ {picked.size}
            </span>
          )}
        </div>
      )}

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
              ? "All athletes are either already checked in, on leave, or have completed their day."
              : "There's nobody to check out right now."}
          </p>
        </div>
      ) : (
        <ul className="iu-card divide-y divide-slate-100 overflow-hidden" data-testid="muster-list">
          {filtered.map((s) => {
            const isPicked = picked.has(s.id);
            const isLocked = mode === "checkin" && s.already_checked_in;
            const inAt = s.check_in_at
              ? new Date(s.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : null;
            return (
              <li
                key={s.id}
                onClick={() => toggle(s.id)}
                className={`flex items-center gap-3 px-4 py-3 transition ${
                  isLocked
                    ? "bg-slate-50 opacity-60 cursor-not-allowed"
                    : isPicked
                      ? "bg-emerald-50 cursor-pointer"
                      : "hover:bg-slate-50 cursor-pointer"
                }`}
                data-testid={`muster-row-${s.id}`}
                aria-disabled={isLocked || undefined}
              >
                <div
                  className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                    isLocked
                      ? "bg-slate-200 border-slate-300 text-slate-400"
                      : isPicked
                        ? "bg-emerald-600 border-emerald-600 text-white"
                        : "border-slate-300"
                  }`}
                  data-testid={`muster-checkbox-${s.id}`}
                >
                  {(isPicked || isLocked) && <CheckSquare size={14}/>}
                </div>
                <Avatar name={s.full_name} photo={s.photo} size={48} ring={isPicked ? "#10B981" : null} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold text-slate-900 truncate flex-1">{s.full_name}</div>
                    {isLocked && (
                      <span
                        title={inAt ? `Checked in at ${inAt}` : "Already checked in"}
                        data-testid={`muster-already-in-${s.id}`}
                        className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold bg-slate-200 text-slate-600 shrink-0"
                      >
                        ✓ {inAt ? `In · ${inAt}` : "Already in"}
                      </span>
                    )}
                    {s.institution && (
                      <span
                        title={`Institution: ${s.institution}`}
                        data-testid={`muster-institution-chip-${s.id}`}
                        className="inline-flex items-center px-1.5 h-5 rounded text-[10px] font-bold bg-sky-100 text-sky-700 shrink-0 max-w-[110px] truncate"
                      >
                        {s.institution}
                      </span>
                    )}
                    <ParentContact father={s.father_mobile} mother={s.mother_mobile} guardian={s.guardian_mobile} />
                  </div>
                  {s.rank && (
                    <div className="text-xs text-slate-500 truncate">{s.rank}</div>
                  )}
                </div>
                {!s.photo && !isLocked && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setPhotoTarget({ id: s.id, full_name: s.full_name }); }}
                    className="ml-2 inline-flex items-center gap-1 px-2 h-7 rounded-full bg-amber-100 text-amber-700 text-[11px] font-bold hover:bg-amber-200 shrink-0"
                    data-testid={`muster-photo-${s.id}`}
                  >
                    <Camera size={11} /> Add photo
                  </button>
                )}
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
              ? <span className="text-slate-400">Tick athletes above to {meta.verb.toLowerCase()}</span>
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

      {photoTarget && (
        <SelfieCapture
          title={`Photo for ${photoTarget.full_name}`}
          subtitle={
            photoTarget.queued
              ? `Capturing photos before check-in · ${photoQueue.length} left. Tap Skip to do it later.`
              : "Point your camera at the athlete. We'll save this to their profile."
          }
          facingMode="environment"
          onCapture={savePhoto}
          onClose={skipPhoto}
        />
      )}
    </div>
  );
}
