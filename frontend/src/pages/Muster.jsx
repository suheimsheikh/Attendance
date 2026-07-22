import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Loader2, Search, RefreshCw, CheckSquare, Square, LogIn, LogOut as LogOutIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import { useAuth } from "../auth";
import SelfieCapture from "../components/SelfieCapture";
import { formatDate, getLocation, resolveNearestSite } from "../utils";
import { useGeoPermission } from "../hooks/useGeoPermission";
import GeoPermissionBanner from "../components/GeoPermissionBanner";
import MusterRow from "./muster/MusterRow";
import { MusterScopeChips, MusterInstitutionChips } from "./muster/MusterFilters";
import MusterBreakdownBar from "./muster/MusterBreakdownBar";
import ExMemberToggle, { useExMemberToggle } from "../components/ExMemberToggle";
import { isExMember } from "../utils/exMember";

const MODES = [
  { key: "checkin",  label: "Check in",  Icon: LogIn,        verb: "Check in",  color: "#10B981" },
  { key: "checkout", label: "Check out", Icon: LogOutIcon,   verb: "Check out", color: "#6B7280" },
];

const CATEGORY_CHIP_STYLE = {
  athlete:   "bg-sky-100 text-sky-700",
  elite:     "bg-rose-100 text-rose-700",
  staff:     "bg-emerald-100 text-emerald-700",
  coach:     "bg-amber-100 text-amber-700",
  executive: "bg-violet-100 text-violet-700",
};

export default function Muster() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [mode, setMode] = useState("checkin");
  // Admins get scope filter (default "all"); coaches/escorts always get athletes.
  const [scope, setScope] = useState(isAdmin ? "all" : "athletes");
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
  const [showEx, setShowEx] = useExMemberToggle("muster");
  // Coach's GPS + geofence context — captured on the FIRST submit tap
  // and reused for the whole batch so all attendance rows are stamped
  // with the same physical location the coach was at.
  const [office, setOffice] = useState(null);
  const [sites, setSites] = useState([]);
  const geoPerm = useGeoPermission();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, o, si] = await Promise.all([
        api.get("/muster/athletes", { mode, scope }),
        api.get("/office").catch(() => null),
        api.get("/sites").catch(() => []),
      ]);
      setData(res);
      setPicked(new Set());
      if (o) setOffice(o);
      setSites(Array.isArray(si) ? si : []);
    } catch (err) {
      showApiError(err, "Couldn't load roster");
    } finally {
      setLoading(false);
    }
  }, [mode, scope]);

  useEffect(() => { load(); }, [load]);
  // Reset institution filter when mode / scope changes so the user always starts broad.
  useEffect(() => { setInstitutionFilter("all"); }, [mode, scope]);

  const runBulk = useCallback(async (ids) => {
    setSaving(true);
    try {
      // Capture the coach's current GPS (best-effort, 8s budget). We
      // stamp lat/lng/site/out_of_geofence on every attendance row so
      // each check-in records WHERE the coach mustered the members.
      let lat = null, lng = null;
      try {
        const loc = await getLocation({ targetAccuracy: 100, maxWaitMs: 8000 });
        lat = loc.latitude; lng = loc.longitude;
      } catch (err) {
        console.debug("muster: coach location unavailable —", err?.message);
      }
      // If we have a fix, resolve against configured geofences. Warn but
      // don't block (coaches are trusted; a wrong location is still
      // logged for the audit trail rather than lost).
      if (lat != null && lng != null && mode === "checkin") {
        const resolved = resolveNearestSite(lat, lng, office, sites);
        if (resolved?.out_of_geofence) {
          // Format distance human-friendly: "~1.2 km" once we're past
          // 1000m, otherwise plain metres. Coaches at a regatta don't
          // need to parse "8667068 m".
          const d = resolved.nearest_distance_m;
          const dStr = d == null
            ? "?"
            : d >= 1000
              ? `${(d / 1000).toFixed(1)} km`
              : `${d} m`;
          const proceed = window.confirm(
            `You're ~${dStr} from ${resolved.nearest_name || "any training location"}.\n\n` +
            "Continue mustering from here?\n" +
            "(All check-ins will be stamped as off-site.)"
          );
          if (!proceed) { setSaving(false); return; }
        } else if (resolved?.site_name) {
          toast.success(`Mustering at ${resolved.site_name}`, { duration: 2000 });
        }
      }

      const endpoint = mode === "checkin" ? "/muster/checkin-bulk" : "/muster/checkout-bulk";
      const payload = { athlete_ids: ids };
      if (lat != null && lng != null) {
        payload.latitude = lat;
        payload.longitude = lng;
      }
      const res = await api.post(endpoint, payload);
      const doneCount = res.checked_in_count ?? res.checked_out_count ?? 0;
      const skipCount = res.skipped_count ?? 0;
      const skipNote = skipCount > 0 ? ` · ${skipCount} skipped` : "";
      const noun = doneCount === 1 ? "member" : "members";
      toast.success(
        mode === "checkin"
          ? `${doneCount} ${noun} marked present${skipNote}`
          : `${doneCount} ${noun} marked departed${skipNote}`
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
  }, [mode, office, sites, load]);

  // Inline "Check out" action for a single already-checked-in member on
  // the check-in list. Lets admins close a stale open session without
  // switching to check-out mode (15 Feb 2026 user request: "greyed rows
  // are not selectable"). Fires the same /muster/checkout-bulk endpoint
  // as the bulk button but scoped to one id.
  const [singleCheckoutId, setSingleCheckoutId] = useState(null);
  const inlineCheckout = useCallback(async (member) => {
    if (!member?.id) return;
    setSingleCheckoutId(member.id);
    try {
      const res = await api.post("/muster/checkout-bulk", { athlete_ids: [member.id] });
      const okCount = res.checked_out_count ?? 0;
      if (okCount > 0) {
        toast.success(`${member.full_name} checked out`);
        load();
      } else {
        toast.error(`Could not check out ${member.full_name}`);
      }
    } catch (err) {
      showApiError(err, "Check out failed");
    } finally {
      setSingleCheckoutId(null);
    }
  }, [load]);

  // Step through the photo queue as an OPTIONAL post-checkin cleanup
  // — check-in has already fired by the time we get here (7 Jul 2026
  // user-requested "non-blocking"). Empty queue just closes the
  // modal; the coach can Skip any single athlete without consequence.
  const advancePhotoQueue = useCallback((queue) => {
    if (queue.length === 0) {
      setPhotoTarget(null);
      setPhotoQueue([]);
      return;
    }
    const next = queue[0];
    setPhotoTarget({ id: next.id, full_name: next.full_name, queued: true });
    setPhotoQueue(queue);
  }, []);

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

  // Distinct institutions present in the current roster. The
  // "(no institution)" bucket is only shown when at least one member
  // in view HAS an institution set — otherwise it's meaningless
  // (e.g. staff/coaches don't carry an institution, so a filter row
  // with just "(no institution) 24" is noise, not signal). Reported
  // 15 Feb 2026 by admin.
  const institutions = useMemo(() => {
    const named = new Map();       // name → count (excl. "(no institution)")
    let unaffiliated = 0;
    (data?.athletes || []).forEach((s) => {
      const inst = (s.institution || "").trim();
      if (inst) {
        named.set(inst, (named.get(inst) || 0) + 1);
      } else {
        unaffiliated += 1;
      }
    });
    const arr = Array.from(named.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Only surface "(no institution)" when there's at least one named
    // institution to contrast it with — otherwise the chip row would
    // just be a single meaningless bucket.
    if (arr.length > 0 && unaffiliated > 0) {
      arr.push({ name: "(no institution)", count: unaffiliated });
    }
    return arr;
  }, [data]);

  const filtered = useMemo(() => {
    const list = data?.athletes || [];
    const q = search.trim().toLowerCase();
    return list.filter((s) => {
      if (!showEx && isExMember(s)) return false;
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
  }, [data, showEx, search, institutionFilter]);

  const exCount = useMemo(() => (data?.athletes || []).filter((s) => isExMember(s)).length, [data]);

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
      toast.error(`Tick at least one ${isAdmin ? "member" : "athlete"} first`);
      return;
    }
    // Snapshot who needs a photo BEFORE we clear the picked set on
    // successful bulk. Check-OUT skips the prompt entirely — athletes
    // are usually leaving in a group and the coach doesn't want to be
    // slowed down. 7 Jul 2026: non-blocking — check-in fires first,
    // photo capture opens as an optional follow-up.
    const needsPhoto = mode === "checkin"
      ? (data?.athletes || []).filter((a) => picked.has(a.id) && !a.photo)
      : [];
    await runBulk(Array.from(picked));
    if (needsPhoto.length > 0) {
      // Small delay so the success toast lands first — otherwise the
      // camera modal opens before the coach registers the check-in
      // succeeded.
      setTimeout(() => advancePhotoQueue(needsPhoto), 400);
    }
  };

  const allVisiblePicked = tickable.length > 0 && tickable.every((s) => picked.has(s.id));

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto pb-32" data-testid="muster-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Muster Roll</h1>
        <p className="text-slate-500 text-sm mt-1">
          {isAdmin
            ? "Tick the members who are physically present. Attendance is logged with your name as the verifier. Your GPS is captured on submit and stamped on each check-in."
            : "Tick the athletes who are physically present. Their attendance is logged with your name as the verifier. Your GPS location is captured on submit and stamped on each check-in."}
        </p>
      </header>

      <GeoPermissionBanner state={geoPerm} />

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

      {/* Scope filter chips — admin only. Lets admins muster staff /
          coaches / executives alongside athletes for payroll tracking.
          Coaches and escorts are server-restricted to athletes. */}
      {isAdmin && <MusterScopeChips scope={scope} onChange={setScope} />}

      {/* Institution filter chips — only meaningful for athletes
          (external school/college affiliation). Staff / coaches /
          executives don't carry an institution semantically, so we
          hide the row entirely on those scopes (15 Feb 2026 user
          feedback: "In muster it says no institution. Is that not
          for Staff and Coaches"). */}
      {(scope === "athletes" || scope === "all") && (
        <MusterInstitutionChips
          institutions={institutions}
          institutionFilter={institutionFilter}
          onChange={setInstitutionFilter}
          totalCount={(data?.athletes || []).length}
        />
      )}

      {/* Search + bulk-tick */}
      <div className="iu-card p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[180px]">
          <Search size={18} className="text-slate-400" />
          <input
            data-testid="muster-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAdmin ? "Filter by name, rank, category…" : "Filter athletes by name or rank…"}
            className="flex-1 outline-none bg-transparent text-sm"
          />
        </div>
        {exCount > 0 && (
          <ExMemberToggle showEx={showEx} onChange={setShowEx} exCount={exCount} />
        )}
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
          <span className="font-bold text-slate-900">{tickable.length}</span> {isAdmin ? (tickable.length === 1 ? "member" : "members") : (tickable.length === 1 ? "athlete" : "athletes")} {mode === "checkin" ? "to check in" : "still on campus"}
          {mode === "checkin" && (filtered.length - tickable.length) > 0 && (
            <> · <span className="text-slate-500">{filtered.length - tickable.length} already in</span></>
          )}
          {picked.size > 0 && (
            <> · <span className="font-bold text-emerald-700">{picked.size}</span> ticked</>
          )}
        </p>
        <p className="text-xs text-slate-400">{data?.date ? formatDate(data.date) : ""}</p>
      </div>

      {/* Sticky breakdown bar — mirrors the per-category chip row on
          Presence columns. Stays visible while the list scrolls so the
          coach always sees the gender split + locked count of the
          currently filtered set. Hidden when the filter resolves to
          zero athletes (the muster-empty card takes over). */}
      {filtered.length > 0 && (
        <MusterBreakdownBar
          breakdown={breakdown}
          mode={mode}
          pickedCount={picked.size}
        />
      )}

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="muster-empty">
          <Users className="mx-auto text-slate-300 mb-2" size={36} />
          <p className="font-semibold text-slate-700">
            {mode === "checkin"
              ? (isAdmin ? "Everyone in this scope is already accounted for" : "Everyone's already accounted for")
              : (isAdmin ? "Nobody in this scope is currently on campus" : "Nobody is currently on campus")}
          </p>
          <p className="text-sm text-slate-500 mt-1">
            {mode === "checkin"
              ? (isAdmin ? "All members here are already checked in, on leave, or off-scope. Try widening the scope filter." : "All athletes are either already checked in, on leave, or have completed their day.")
              : "There's nobody to check out right now."}
          </p>
        </div>
      ) : (
        <ul className="iu-card divide-y divide-slate-100 overflow-hidden" data-testid="muster-list">
          {filtered.map((s) => {
            const isPicked = picked.has(s.id);
            const isLocked = mode === "checkin" && s.already_checked_in;
            return (
              <MusterRow
                key={s.id}
                member={s}
                isPicked={isPicked}
                isLocked={isLocked}
                isAdmin={isAdmin}
                singleCheckoutBusy={singleCheckoutId === s.id}
                onToggle={toggle}
                onAddPhoto={(m) => setPhotoTarget({ id: m.id, full_name: m.full_name })}
                onInlineCheckout={inlineCheckout}
                categoryChipStyle={CATEGORY_CHIP_STYLE}
              />
            );
          })}
        </ul>
      )}

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 md:left-64 bg-white border-t border-slate-200 p-3 md:p-4 z-40">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="flex-1 text-sm">
            {picked.size === 0
              ? <span className="text-slate-400">Tick {isAdmin ? "members" : "athletes"} above to {meta.verb.toLowerCase()}</span>
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
              ? `Checked in ✓ — capture their photo while they're here. ${photoQueue.length} left · tap Skip or close (×) to bail anytime.`
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
