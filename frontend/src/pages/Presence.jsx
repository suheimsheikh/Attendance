import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { api, showApiError } from "../api";
import GuestCheckInModal from "../components/GuestCheckInModal";
import MemberForm from "./admin/MemberForm";
import { useAuth } from "../auth";
import { toast } from "sonner";
import UpcomingThisWeek from "../components/UpcomingThisWeek";
import EscortMissingBanner from "../components/EscortMissingBanner";
import SelfieCapture from "../components/SelfieCapture";
import { useAthleteLikeKeys } from "../hooks/useAthleteLikeKeys";

import { COLUMNS, STATUS_TO_COLUMN } from "../components/presence/constants";
import { Column } from "../components/presence/Column";
import { GuestStrip } from "../components/presence/GuestStrip";
import { EscortsStrip } from "../components/presence/EscortsStrip";
import { SkeletonBoard } from "../components/presence/SkeletonBoard";
import { PresenceHeader } from "../components/presence/PresenceHeader";
import { FleetFilterRow } from "../components/presence/FleetFilterRow";
import { LocationFilterRow } from "../components/presence/LocationFilterRow";
import MissingPhotoStrip from "../components/presence/MissingPhotoStrip";
import ExMemberToggle, { useExMemberToggle } from "../components/ExMemberToggle";
import { isExMember } from "../utils/exMember";

export default function Presence() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const canManageGuests = isAdmin || currentUser?.category === "coach";
  // Athlete-like categories (athlete + elite + any custom athlete-like
  // category) — powers the "missing photo on campus" strip filter below
  // so Elite squad members show up in the drainage queue too.
  const athleteLikeKeys = useAthleteLikeKeys();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);  const [fleetFilter, setFleetFilter] = useState("");  // "" = all fleets
  // Location filter — set via the pill row OR deep-linked from the Admin
  // Dashboard by-location chips (?location=Rowing%20Academy). Only applies
  // to today's live view; historical days won't have on-campus rows anyway.
  const [searchParams, setSearchParams] = useSearchParams();
  const [locationFilter, setLocationFilter] = useState(
    searchParams.get("location") || ""
  );
  const [query, setQuery] = useState("");
  // Ex-member visibility toggle — default OFF so the board stays crisp.
  // Ex-members whose status is anything other than "off_campus" for
  // days after their leaving_date shouldn't appear here anyway, but
  // the roster still lists them until we filter (24 Feb 2026).
  const [showEx, setShowEx] = useExMemberToggle("presence");
  const [guests, setGuests] = useState({ active: [], completed: [], active_count: 0 });
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [editingMember, setEditingMember] = useState(null);
  // YYYY-MM-DD or "" for "today" (live mode). Picking a past date switches
  // the board to a read-only historical view (no auto-refresh, no notify).
  // Use LOCAL date — `toISOString()` would give UTC and trip the next-day
  // logic across IST midnight (off-by-one between UTC and Asia/Kolkata).
  const todayIso = useCallback(() => new Date().toLocaleDateString("sv-SE"), []);
  // Add `delta` days to a YYYY-MM-DD string, returning a YYYY-MM-DD string
  // in the *local* calendar (toISOString would silently convert to UTC and
  // break the right-arrow advance in IST).
  const shiftIso = useCallback((iso, delta) => {
    const d = new Date(iso + "T12:00:00");  // noon avoids DST edge cases
    d.setDate(d.getDate() + delta);
    return d.toLocaleDateString("sv-SE");
  }, []);
  const [viewDate, setViewDate] = useState("");
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  // Compact / detailed density (7 Jul 2026 — user request). Persisted
  // to localStorage so the coach's preference survives page refresh /
  // browser restart. Default is `detailed` which is the pre-existing
  // rich card layout.
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem("presence.density") || "detailed"; }
    catch { return "detailed"; }
  });
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next = d === "compact" ? "detailed" : "compact";
      try { localStorage.setItem("presence.density", next); } catch { /* private mode */ }
      return next;
    });
  }, []);
  const today = todayIso();
  const isHistorical = !!viewDate && viewDate !== today;

  const load = useCallback(async () => {
    try {
      setError(false);
      const qs = isHistorical ? `?on=${viewDate}` : "";
      const [res, gRes] = await Promise.all([
        api.get(`/presence${qs}`),
        canManageGuests && !isHistorical ? api.get("/guests/today").catch(() => null) : Promise.resolve(null),
      ]);
      setData(res);
      if (gRes) setGuests(gRes);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [canManageGuests, viewDate, isHistorical]);

  const toggleRow = useCallback((memberId) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }, []);

  // Open the Members edit modal by fetching the full doc (Presence rows only
  // carry a subset of fields). Admin-only — coaches don't see the option.
  const openEdit = useCallback(async (memberId) => {
    if (!isAdmin) return;
    try {
      const full = await api.get(`/members/${memberId}`);
      setEditingMember(full);
    } catch (err) {
      showApiError(err, "Couldn't load member");
    }
  }, [isAdmin]);

  // Remove a member from On Campus by deleting their open session for today.
  // The member instantly disappears from the board and can check in again via
  // Self Check-In or Muster Roll — useful when a member was wrongly marked
  // present (mis-tap, double-scan, accidental muster).
  const removeFromCampus = useCallback(async (memberId, memberName) => {
    if (!isAdmin) return;
    const ok = window.confirm(
      `Remove ${memberName} from On Campus?\n\n` +
      `Their current check-in for today will be cleared, and they can check in again via Self Check-In or Muster.\n\n` +
      `This does NOT affect their photo, profile, or past attendance.`
    );
    if (!ok) return;
    try {
      await api.del(`/admin/attendance/open-session/${memberId}`);
      toast.success(`${memberName} removed from On Campus`);
      load();
    } catch (err) {
      showApiError(err, "Couldn't remove — they may have already checked out");
    }
  }, [isAdmin, load]);

  // Single dispatcher for member-card double-clicks. On Campus members get the
  // "Remove from On Campus" confirm; every other status keeps the edit-modal
  // behavior (admins can fix a member's profile from anywhere on the board).
  const handleMemberDoubleClick = useCallback((memberId) => {
    if (!isAdmin) return;
    const m = (data?.members || []).find((x) => x.id === memberId);
    if (m && m.status === "on_campus") {
      removeFromCampus(memberId, m.full_name);
    } else {
      openEdit(memberId);
    }
  }, [isAdmin, data, openEdit, removeFromCampus]);

  const checkoutGuest = async (guestId, name) => {
    try {
      await api.post(`/guests/${guestId}/checkout`);
      toast.success(`${name} checked out`);
      load();
    } catch (err) {
      showApiError(err, "Failed");
    }
  };

  const deleteGuest = async (guestId, name) => {
    if (!window.confirm(`Remove ${name}'s check-in entry?`)) return;
    try {
      await api.del(`/guests/${guestId}`);
      toast.success("Guest entry removed");
      load();
    } catch (err) {
      showApiError(err, "Failed");
    }
  };

  useEffect(() => {
    load();
    // Historical view: read-only, no auto-refresh.
    if (isHistorical) return;
    // Gate polling on tab visibility — a backgrounded tab doesn't need
    // a fresh roster every 15 s and 60+ coaches all polling at once
    // hammers the API for nothing.
    let t = null;
    const start = () => {
      if (t == null) t = setInterval(load, 15000);
    };
    const stop = () => {
      if (t != null) { clearInterval(t); t = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        load();    // catch up immediately on tab focus
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, isHistorical]);

  const byColumn = useMemo(() => {
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    const q = query.trim().toLowerCase();
    const members = (data?.members || []).filter((m) => {
      if (!showEx && isExMember(m)) return false;
      if (lateOnly && !m.late) return false;
      if (fleetFilter && (m.fleet || "") !== fleetFilter) return false;
      // Location filter only makes sense for statuses that carry a
      // site_name (on_campus + temp_out). If a location is picked, hide
      // members outside that location; a member on leave/tour/absent
      // has no site_name so they naturally drop out — which matches the
      // user's mental model ("who's at Rowing right now"). Skip the
      // filter on historical views since site_name isn't tagged there.
      if (locationFilter && !isHistorical && (m.site_name || "") !== locationFilter) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q)
        || (m.rank || "").toLowerCase().includes(q)
        || (m.category || "").toLowerCase().includes(q)
        || (m.institution || "").toLowerCase().includes(q)
        || (m.fleet || "").toLowerCase().includes(q);
    });
    for (const m of members) {
      // on_tour + on_leave both drop into the merged "away" column; the
      // MemberCard renders a coloured pill (Tour orange / Leave amber)
      // so admins can still tell them apart at a glance.
      const bucketKey = STATUS_TO_COLUMN[m.status] || m.status;
      if (buckets[bucketKey]) buckets[bucketKey].push(m);
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((a, b) => {
        const da = a.since ? new Date(a.since).getTime() : 0;
        const db = b.since ? new Date(b.since).getTime() : 0;
        if (db !== da) return db - da;
        return (a.full_name || "").localeCompare(b.full_name || "");
      });
    }
    return buckets;
  }, [data, showEx, lateOnly, fleetFilter, locationFilter, query, isHistorical]);

  const exCount = useMemo(() => (data?.members || []).filter((m) => isExMember(m)).length, [data]);

  // Distinct fleet labels present across loaded members — used to render the
  // filter pill row. Athletes without a fleet set are not surfaced here.
  const fleetOptions = useMemo(() => {
    const set = new Set();
    for (const m of data?.members || []) {
      if (m.fleet) set.add(m.fleet);
    }
    return Array.from(set).sort();
  }, [data]);

  // On Campus + Checked Out used to be rendered as "paired" columns
  // with invisible blank placeholders so their rows aligned pixel-by-
  // pixel. Removed 7 Jul 2026 — users read the gaps as broken layout,
  // not as alignment. Both columns now render only their own members.

  const filteredTotal = useMemo(
    () => Object.values(byColumn).reduce((sum, list) => sum + list.length, 0),
    [byColumn]
  );

  // Bucket escorts by status so each column gets only its own rows.
  // Single pass keeps the strip + columns in sync (one data source).
  // Skipped on historical views (backend returns []).
  const escortsByStatus = useMemo(() => {
    const buckets = { on_campus: [], temp_out: [], exited: [] };
    for (const e of data?.escorts_present || []) {
      const k = buckets[e.status] ? e.status : (e.temp_out ? "temp_out" : "on_campus");
      buckets[k].push(e);
    }
    return buckets;
  }, [data]);
  // Escorts strip flattens on-campus + stepped-out into one visible
  // list. Memoised so the array identity is stable across re-renders
  // (7 Jul 2026 code review — inline `[...a, ...b]` in JSX broke
  // EscortsStrip's own memoisation).
  const escortsForStrip = useMemo(
    () => [...escortsByStatus.on_campus, ...escortsByStatus.temp_out],
    [escortsByStatus]
  );

  const totalMembers = data?.counts?.total ?? (data?.members?.length || 0);
  const lateCount = data?.counts?.late || 0;
  const absentCount = data?.counts?.absent || 0;

  // On-campus athletes without a photo — opportunistic photo drainage
  // (7 Jul 2026 user request). Coach clicks the strip, we walk through
  // a SelfieCapture queue same as Muster. Athletes only — staff/coaches
  // rarely appear on the presence board and don't need drainage.
  const missingPhotoOnCampus = useMemo(() => (
    (data?.members || [])
      .filter((m) => m.status === "on_campus"
        && (athleteLikeKeys.has(m.category) || !m.category)
        && !m.photo)
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""))
  ), [data, athleteLikeKeys]);

  const [photoTarget, setPhotoTarget] = useState(null);
  const [photoQueue, setPhotoQueue] = useState([]);
  const advancePhotoQueue = useCallback((queue) => {
    if (queue.length === 0) {
      setPhotoTarget(null);
      setPhotoQueue([]);
      // Refresh the board so the freshly-captured photos show up.
      load();
      return;
    }
    const next = queue[0];
    setPhotoTarget({ id: next.id, full_name: next.full_name });
    setPhotoQueue(queue);
  }, [load]);
  const savePhoto = async (dataUrl) => {
    if (!photoTarget) return;
    try {
      await api.post(`/members/${photoTarget.id}/photo`, { photo: dataUrl });
      toast.success(`Photo saved for ${photoTarget.full_name}`);
    } catch (err) {
      showApiError(err, "Failed to save photo");
      return;
    }
    advancePhotoQueue(photoQueue.slice(1));
  };
  const skipPhoto = () => advancePhotoQueue(photoQueue.slice(1));

  return (
    <div className="p-4 md:p-6 max-w-[1500px] mx-auto">
      {!isHistorical && <UpcomingThisWeek />}
      {!isHistorical && <EscortMissingBanner />}
      <PresenceHeader
        data={data}
        isHistorical={isHistorical}
        today={today}
        viewDate={viewDate}
        shiftIso={shiftIso}
        onViewDateChange={(next) => { setViewDate(next); setExpandedRows(new Set()); }}
        lateOnly={lateOnly}
        onToggleLateOnly={() => setLateOnly((v) => !v)}
        lateCount={lateCount}
        absentCount={absentCount}
        canManageGuests={canManageGuests}
        onAddGuest={() => setShowGuestModal(true)}
        activeGuestCount={guests.active_count}
        totalMembers={totalMembers}
        onRefresh={load}
        density={density}
        onToggleDensity={toggleDensity}
      />

      <FleetFilterRow
        fleetOptions={fleetOptions}
        fleetFilter={fleetFilter}
        onFleetChange={setFleetFilter}
      />

      {exCount > 0 && (
        <div className="flex items-center gap-2 px-2 md:px-3 -mt-1 mb-2">
          <ExMemberToggle showEx={showEx} onChange={setShowEx} exCount={exCount} />
          <span className="text-[11px] text-slate-400">
            {showEx ? "Including" : "Hiding"} {exCount} ex-member{exCount === 1 ? "" : "s"}.
          </span>
        </div>
      )}

      <LocationFilterRow
        locations={data?.by_location || []}
        locationFilter={locationFilter}
        onLocationChange={(loc) => {
          setLocationFilter(loc);
          // Keep the querystring in sync so a hard refresh preserves the
          // filter — same trick as the deep-link from Admin Dashboard.
          const next = new URLSearchParams(searchParams);
          if (loc) next.set("location", loc); else next.delete("location");
          setSearchParams(next, { replace: true });
        }}
      />

      {!isHistorical && (
        <MissingPhotoStrip
          members={missingPhotoOnCampus}
          onStart={advancePhotoQueue}
        />
      )}

      <div className="iu-card mb-4 px-3 py-2 flex items-center gap-3" data-testid="presence-search-wrap">
        <Search size={16} className="text-sky-500 shrink-0" />
        <input
          data-testid="presence-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, rank, category or institution…"
          className="flex-1 outline-none bg-transparent text-sm"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            data-testid="presence-search-clear"
            className="text-[11px] font-semibold text-sky-700 hover:text-sky-900"
          >
            Clear · {filteredTotal} match{filteredTotal === 1 ? "" : "es"}
          </button>
        )}
      </div>

      {canManageGuests && (
        <GuestStrip
          guests={guests}
          onCheckout={checkoutGuest}
          onDelete={deleteGuest}
          onAdd={() => setShowGuestModal(true)}
        />
      )}

      {/* Escorts checked in via /escort-checkin — non-user entities so they
          don't appear in any of the six columns. Only renders when at least
          one escort is on campus. Skipped on historical views (escort
          attendance isn't reconciled into past-day reads). The strip shows
          escorts who are still on campus (on_campus + temp_out) — checked-
          out escorts surface in the Exited column directly. */}
      {!isHistorical && (
        <EscortsStrip
          escorts={escortsForStrip}
        />
      )}

      {loading && !data ? (
        <SkeletonBoard />
      ) : error ? (
        <div className="iu-card p-10 text-center">
          <p className="text-slate-500">Failed to load presence data.</p>
          <button onClick={load} className="iu-btn-primary mt-4">Retry</button>
        </div>
      ) : (
        <div
          className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-4"
          data-testid="presence-board"
        >
          {COLUMNS.map((col) => (
            <Column
              key={col.key}
              col={col}
              members={byColumn[col.key]}
              displayList={null}
              escorts={escortsByStatus[col.key] || null}
              adminContacts={data?.admin_contacts || []}
              coachMobile={currentUser?.mobile}
              onSent={load}
              onRowDoubleClick={isAdmin ? handleMemberDoubleClick : null}
              expandedRows={expandedRows}
              toggleRow={toggleRow}
              density={density}
            />
          ))}
        </div>
      )}

      {showGuestModal && (
        <GuestCheckInModal
          onClose={() => setShowGuestModal(false)}
          onCheckedIn={load}
        />
      )}
      {editingMember && (
        <MemberForm
          initial={editingMember}
          onClose={() => setEditingMember(null)}
          onSaved={() => { setEditingMember(null); load(); }}
        />
      )}
      {photoTarget && (
        <SelfieCapture
          title={`Photo for ${photoTarget.full_name}`}
          subtitle={`They're on campus now — quick tap and next. ${photoQueue.length} left · Skip or × to bail.`}
          facingMode="environment"
          onCapture={savePhoto}
          onClose={skipPhoto}
        />
      )}
    </div>
  );
}
