import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ArrowLeftRight, Camera, X, Clock, Coffee, Search, CheckCircle2, LogOut, LogIn, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useAuth } from "../auth";
import Avatar from "../components/Avatar";
import SelfieCapture from "../components/SelfieCapture";
import { fileToResizedDataUrl } from "../utils";
import { useEscape } from "../hooks/useEscape";
import { shareToWhatsApp, formatCheckinCaption, dataUrlToBlob } from "../utils/shareWhatsApp";

/**
 * EscortCheckIn — kiosk-style page used by both escorts themselves
 * (phone-login routes them here when their phone matches an active
 * escort) and by coaches/admins acting as a proxy for an escort who
 * doesn't have the app.
 *
 * Flow:
 *  1. Pick the escort (skipped when caller IS the escort).
 *  2. If not checked in today → show Check-in card with athlete
 *     checklist + optional selfie.
 *  3. If checked in → show "On campus" status with Step-out + Check-out
 *     options. Step-out flow mirrors the SelfCheckIn temp-exit chips.
 *
 * Athletes shown in the checklist come from the same institution as
 * the picked escort — that's the working assumption ("escorts drop off
 * their institution's children"). The list still shows everyone if the
 * institution match returns zero athletes, as a fallback.
 */
export default function EscortCheckIn() {
  const { user } = useAuth();
  const isEscort = !!user?.is_escort;
  const [snapshot, setSnapshot] = useState(null);   // { date, escorts, attendance }
  const [picked, setPicked] = useState(null);       // escort dict
  const [athletes, setAthletes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Refresh today's snapshot — drives the live "X expected, Y not in"
  // strip and decides whether to show the check-in or step-out card.
  const load = useCallback(async () => {
    try {
      const snap = await api.get("/escort-attendance/today");
      setSnapshot(snap);
      // Self-mode: lock the picker to the calling escort.
      if (isEscort && snap.escorts) {
        const self = snap.escorts.find((e) => e.id === user.escort_id);
        if (self) setPicked(self);
      }
    } catch (err) {
      toast.error(err?.message || "Could not load today's escort status");
    } finally {
      setLoading(false);
    }
  }, [isEscort, user?.escort_id]);
  useEffect(() => { load(); }, [load]);

  // Athletes are loaded once globally; the check-in card filters them
  // by the picked escort's institution.
  useEffect(() => {
    api.get("/members", { category: "athlete" }).then(setAthletes).catch(() => {});
  }, []);

  // Hooks below must run on every render — keep them before the early
  // returns so the order stays stable per the rules-of-hooks.
  const escorts = useMemo(() => snapshot?.escorts || [], [snapshot]);
  const attMap = useMemo(() => {
    const m = {};
    (snapshot?.attendance || []).forEach((a) => { m[a.escort_id] = a; });
    return m;
  }, [snapshot]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return escorts;
    return escorts.filter((e) =>
      (e.name || "").toLowerCase().includes(q) ||
      (e.institution || "").toLowerCase().includes(q)
    );
  }, [escorts, search]);

  const stats = useMemo(() => {
    const total = escorts.length;
    const checkedIn = escorts.filter((e) => attMap[e.id]?.check_in_at).length;
    const checkedOut = escorts.filter((e) => attMap[e.id]?.check_out_at).length;
    const onStepOut = escorts.filter((e) => {
      const a = attMap[e.id];
      return a && a.check_in_at && !a.check_out_at && (a.excursions || []).some((x) => !x.return_at);
    }).length;
    return { total, checkedIn, checkedOut, onStepOut, missing: total - checkedIn };
  }, [escorts, attMap]);

  if (loading) {
    return <div className="p-10 text-center"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>;
  }
  if (!snapshot) return null;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Escorts Check in/Out</h1>
        <p className="text-slate-500 text-sm mt-1">
          {isEscort
            ? "Welcome — log your arrival, departure, and any quick step-outs."
            : "Help an escort check in / out, or step out for a quick errand. Pick them from the list below."}
        </p>
      </header>

      {/* Live count strip — also drives the admin "Y not yet in" banner. */}
      <div className="iu-card !p-3 mb-4 grid grid-cols-4 gap-2 text-center" data-testid="escort-stats">
        <StatPill label="Expected" value={stats.total} tone="slate" />
        <StatPill label="Checked in" value={stats.checkedIn} tone="emerald" />
        <StatPill label="Stepped out" value={stats.onStepOut} tone="sky" />
        <StatPill label={stats.missing > 0 ? "Not in yet" : "All in ✓"} value={stats.missing} tone={stats.missing > 0 ? "red" : "emerald"} />
      </div>

      {/* Picker — hidden in self mode (escort is the only valid target). */}
      {!isEscort && !picked && (
        <div className="iu-card p-4 mb-4">
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              data-testid="escort-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search escort by name or institution…"
              className="iu-input pl-10"
            />
          </div>
          {filtered.length === 0 ? (
            <div className="text-sm text-slate-500 text-center py-6">No active escorts. Ask admin to add one.</div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[55vh] overflow-y-auto" data-testid="escort-picker">
              {filtered.map((e) => (
                <EscortPickerRow key={e.id} escort={e} att={attMap[e.id]} onPick={() => setPicked(e)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action card — shown once an escort is picked. */}
      {picked && (
        <EscortActionCard
          escort={picked}
          att={attMap[picked.id]}
          athletes={athletes}
          onChange={async () => { await load(); }}
          onBack={isEscort ? null : () => setPicked(null)}
          isEscort={isEscort}
        />
      )}
    </div>
  );
}

function StatPill({ label, value, tone = "slate" }) {
  const TONE = {
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    red:     "text-red-700 bg-red-50 border-red-200",
    sky:     "text-sky-700 bg-sky-50 border-sky-100",
    slate:   "text-slate-700 bg-slate-50 border-slate-100",
  };
  return (
    <div className={`rounded-md border px-2 py-1.5 ${TONE[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-80">{label}</div>
      <div className="text-2xl font-extrabold leading-tight">{value}</div>
    </div>
  );
}

function EscortPickerRow({ escort, att, onPick }) {
  const status = !att ? "Not in"
    : att.check_out_at ? "Done"
      : (att.excursions || []).some((x) => !x.return_at) ? "Stepped out"
        : "On campus";
  const tone = status === "On campus" ? "bg-emerald-50 border-emerald-200 text-emerald-800"
             : status === "Stepped out" ? "bg-sky-50 border-sky-200 text-sky-800"
             : status === "Done" ? "bg-slate-50 border-slate-200 text-slate-600"
             : "bg-white border-slate-200 text-slate-700";
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid={`escort-pick-${escort.id}`}
      className={`text-left rounded-lg border px-3 py-2.5 hover:shadow-sm transition ${tone}`}
    >
      <div className="flex items-start gap-2">
        <Avatar name={escort.name} size={32} />
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">{escort.name}</div>
          <div className="text-[11px] opacity-70 truncate">{escort.institution}</div>
        </div>
        <span className="text-[10px] uppercase tracking-wide font-bold opacity-80 self-center">{status}</span>
      </div>
    </button>
  );
}

/**
 * EscortActionCard — branches on the picked escort's state today:
 *   • No row     → CheckInForm (athlete checklist + optional selfie)
 *   • Checked in → status + Step-out / Check-out actions
 *   • Stepped out→ "Return" + Check-out
 *   • Checked out→ recap; (re-)check-in is admin-only territory
 */
function EscortActionCard({ escort, att, athletes, onChange, onBack, isEscort: _isEscort }) {
  const checkedIn = !!att?.check_in_at;
  const checkedOut = !!att?.check_out_at;
  const openExcursion = (att?.excursions || []).find((x) => !x.return_at);
  // Just-captured selfies are held locally so the post-submit transition
  // can render the thumbnail immediately, without waiting for a
  // re-fetch (and without the heavy base64 round-trip the `/today`
  // strip endpoint deliberately avoids).
  const [justCapturedIn, setJustCapturedIn] = useState("");
  const [justCapturedOut, setJustCapturedOut] = useState("");

  return (
    <div className="iu-card p-5 space-y-3" data-testid="escort-action-card">
      <header className="flex items-center gap-3">
        <Avatar name={escort.name} size={48} />
        <div className="flex-1 min-w-0">
          <div className="text-lg font-extrabold truncate">{escort.name}</div>
          <div className="text-xs text-slate-500 truncate">{escort.institution}</div>
        </div>
        {onBack && (
          <button onClick={onBack} className="text-slate-400 hover:text-slate-700" data-testid="escort-back" title="Back to the escort list">
            <X size={18} />
          </button>
        )}
      </header>

      {checkedOut ? (
        <CheckedOutRecap att={att} localInSelfie={justCapturedIn} localOutSelfie={justCapturedOut} />
      ) : !checkedIn ? (
        <EscortCheckInForm
          escort={escort}
          athletes={athletes}
          onChange={async (capturedSelfie) => {
            if (capturedSelfie) setJustCapturedIn(capturedSelfie);
            await onChange();
          }}
        />
      ) : (
        <OnCampusActions
          escort={escort}
          att={att}
          athletes={athletes}
          openExcursion={openExcursion}
          localInSelfie={justCapturedIn}
          onCheckoutCaptured={setJustCapturedOut}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function EscortCheckInForm({ escort, athletes, onChange }) {
  const [pickedIds, setPickedIds] = useState(new Set());
  const [selfie, setSelfie] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const sameInst = athletes.filter((a) => (a.institution || "") === (escort.institution || ""));
  const list = sameInst.length > 0 ? sameInst : athletes;

  const toggle = (id) => {
    setPickedIds((s) => {
      const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
    });
  };

  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/escort-attendance/checkin", {
        escort_id: escort.id,
        athlete_ids: [...pickedIds],
        selfie: selfie || null,
      });
      toast.success(`${escort.name} checked in`);
      // Hand the just-captured photo up so the next card can show it
      // as a thumbnail immediately, without a separate API round-trip.
      await onChange(selfie || "");
    } catch (err) { toast.error(err?.message || "Check-in failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3" data-testid="escort-checkin-form">
      <div>
        <div className="iu-label">Who are you escorting today? <span className="text-slate-400 normal-case font-normal">(tick all)</span></div>
        <AthleteCheckboxList list={list} pickedIds={pickedIds} onToggle={toggle} />
      </div>
      <SelfieRow value={selfie} onCapture={() => setShowCamera(true)} onClear={() => setSelfie("")} />
      {showCamera && (
        <SelfieCapture
          onCapture={async (file) => {
            try {
              const dataUrl = await fileToResizedDataUrl(file, 480, 480, 0.7);
              setSelfie(dataUrl);
            } catch (err) { toast.error(err?.message || "Could not save photo"); }
            setShowCamera(false);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
      <button
        data-testid="escort-checkin-submit"
        disabled={busy}
        onClick={submit}
        className="iu-btn-primary w-full"
      >
        {busy ? <Loader2 className="animate-spin" size={16} /> : <><LogIn size={16} /> Check in</>}
      </button>
    </div>
  );
}

function OnCampusActions({ escort, att, athletes, openExcursion, localInSelfie, onCheckoutCaptured, onChange }) {
  const [showStepOut, setShowStepOut] = useState(false);
  const [showCheckOut, setShowCheckOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);

  const doReturn = async () => {
    setBusy(true);
    try {
      await api.post("/escort-attendance/return", { escort_id: escort.id });
      toast.success("Welcome back!");
      await onChange();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  // One-tap WhatsApp share of the check-in — pulls the just-captured
  // selfie (when available) or the server thumbnail, and hands the
  // OS share sheet the photo + caption. Coach then picks the parents
  // WhatsApp group. Falls back to a text-only wa.me link on desktop.
  const doShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      let blob = null;
      if (localInSelfie) {
        blob = await dataUrlToBlob(localInSelfie);
      } else if (att.has_check_in_selfie) {
        try {
          const res = await api.get(`/escort-attendance/${att.id}/selfie`, { kind: "in" });
          blob = await dataUrlToBlob(res?.data_url);
        } catch { /* text-only fallback below */ }
      }
      await shareToWhatsApp({
        text: formatCheckinCaption({
          action: "checkin",
          name: escort.name,
          siteName: escort.institution || "",
          when: att.check_in_at ? new Date(att.check_in_at) : new Date(),
        }),
        imageBlob: blob,
        filename: `checkin-${escort.name.replace(/\s+/g, "-")}.jpg`,
      });
    } catch (err) {
      toast.error(err?.message || "Could not open share sheet");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="escort-on-campus">
      <div className="rounded-lg bg-emerald-50/70 border border-emerald-200 px-3 py-2 text-sm" data-testid="escort-status">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 font-bold text-emerald-800">
              <CheckCircle2 size={16} /> On campus since {new Date(att.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
            </div>
            {openExcursion && (
              <div className="text-xs text-sky-800 mt-1">
                Currently stepped out · {openExcursion.reason}{openExcursion.expected_return ? ` · back by ${openExcursion.expected_return}` : ""}
              </div>
            )}
            {(att.check_in_athlete_ids || []).length > 0 && (
              <div className="text-xs text-emerald-700/80 mt-1">
                Escorting {att.check_in_athlete_ids.length} athlete{att.check_in_athlete_ids.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
          <SelfieThumbnail
            attId={att.id}
            kind="in"
            localDataUrl={localInSelfie}
            hasOnServer={att.has_check_in_selfie}
            label="Check-in photo"
            testId="escort-checkin-thumb"
          />
        </div>
        <button
          type="button"
          data-testid="escort-share-whatsapp"
          onClick={doShare}
          disabled={sharing}
          title="Share this check-in with parents on WhatsApp"
          className="mt-2 inline-flex items-center gap-2 px-3 h-8 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-sm transition disabled:opacity-60"
        >
          {sharing ? <Loader2 className="animate-spin" size={13} /> : <Share2 size={13} />}
          Share to WhatsApp
        </button>
      </div>

      {openExcursion ? (
        <button
          data-testid="escort-return"
          onClick={doReturn}
          disabled={busy}
          className="iu-btn-primary w-full"
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <><ArrowLeftRight size={16}/> I&apos;m back</>}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button data-testid="escort-step-out" onClick={() => setShowStepOut(true)} title="Escort steps out briefly and will return" className="iu-btn-secondary"><Coffee size={14}/> Step out</button>
          <button data-testid="escort-checkout-open" onClick={() => setShowCheckOut(true)} title="Escort is leaving for the day — take a photo and check out" className="iu-btn-primary"><LogOut size={14}/> Check out</button>
        </div>
      )}

      {showStepOut && (
        <EscortStepOutForm escort={escort} onClose={() => setShowStepOut(false)} onDone={async () => { setShowStepOut(false); await onChange(); }} />
      )}
      {showCheckOut && (
        <EscortCheckOutForm
          escort={escort}
          athletes={athletes}
          initialAthleteIds={att.check_in_athlete_ids || []}
          onClose={() => setShowCheckOut(false)}
          onCaptured={onCheckoutCaptured}
          onDone={async () => { setShowCheckOut(false); await onChange(); }}
        />
      )}
    </div>
  );
}

function CheckedOutRecap({ att, localInSelfie, localOutSelfie }) {
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm space-y-2" data-testid="escort-recap">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-bold text-slate-700 inline-flex items-center gap-2">
            <CheckCircle2 size={14} className="text-emerald-600"/> Done for today
          </div>
          <div className="text-xs text-slate-600 mt-0.5">
            In {new Date(att.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })} → Out {new Date(att.check_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
          </div>
          {(att.excursions || []).length > 0 && (
            <div className="text-xs text-slate-500 mt-0.5">
              {(att.excursions || []).length} step-out{att.excursions.length === 1 ? "" : "s"} during the day
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <SelfieThumbnail
            attId={att.id}
            kind="in"
            localDataUrl={localInSelfie}
            hasOnServer={att.has_check_in_selfie}
            label="Check-in"
            testId="escort-recap-thumb-in"
          />
          <SelfieThumbnail
            attId={att.id}
            kind="out"
            localDataUrl={localOutSelfie}
            hasOnServer={att.has_check_out_selfie}
            label="Check-out"
            testId="escort-recap-thumb-out"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * SelfieThumbnail — small 56×56 preview with a tap-to-zoom modal.
 *
 * Resolution order:
 *   1. `localDataUrl` (just captured this session) — shown instantly.
 *   2. `/escort-attendance/{att_id}/selfie?kind=in|out` — lazy-fetched
 *      once when `hasOnServer` is true. The `/today` endpoint
 *      deliberately strips the heavy base64 to keep the kiosk list
 *      payload small, so we fetch on-demand only when the kiosk
 *      actually needs to display.
 * Renders nothing when no photo exists for that side.
 */
function SelfieThumbnail({ attId, kind, localDataUrl, hasOnServer, label, testId }) {
  const [fetched, setFetched] = useState("");
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEscape(zoom ? () => setZoom(false) : null);

  useEffect(() => {
    let cancelled = false;
    if (localDataUrl || !hasOnServer || !attId) return;
    setLoading(true);
    api.get(`/escort-attendance/${attId}/selfie`, { kind })
      .then((res) => { if (!cancelled) setFetched(res?.data_url || ""); })
      .catch(() => { /* swallowed — thumbnail just stays hidden on error */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [attId, kind, hasOnServer, localDataUrl]);

  const src = localDataUrl || fetched;
  if (!src && !loading) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => src && setZoom(true)}
        title={`${label} — tap to enlarge`}
        className="relative w-14 h-14 rounded-md overflow-hidden border border-slate-200 bg-slate-100 shrink-0 hover:ring-2 hover:ring-emerald-300 transition"
        data-testid={testId}
        disabled={!src}
      >
        {loading && !src ? (
          <Loader2 size={14} className="absolute inset-0 m-auto animate-spin text-slate-400"/>
        ) : (
          <img src={src} alt={label} className="w-full h-full object-cover" />
        )}
        <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[9px] uppercase tracking-wider py-0.5 text-center font-semibold">
          {label}
        </span>
      </button>
      {zoom && src && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setZoom(false)}
          data-testid={`${testId}-zoom`}
        >
          <img src={src} alt={label} className="max-w-full max-h-full rounded-lg shadow-xl" />
          <button
            className="absolute top-4 right-4 text-white/80 hover:text-white"
            onClick={() => setZoom(false)}
            data-testid={`${testId}-zoom-close`}
          >
            <X size={22}/>
          </button>
        </div>
      )}
    </>
  );
}

const STEP_OUT_DURATIONS = [
  { min: 30,  label: "30 min" },
  { min: 60,  label: "1 hour" },
  { min: 120, label: "2 hours" },
];

function fmtHmLocal(d) {
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

function EscortStepOutForm({ escort, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const [durationMin, setDurationMin] = useState(60);
  const [customTime, setCustomTime] = useState("");
  const [busy, setBusy] = useState(false);
  const computedReturn = (() => {
    if (durationMin == null) return customTime || "";
    const now = new Date();
    now.setMinutes(now.getMinutes() + durationMin);
    return fmtHmLocal(now);
  })();
  const submit = async () => {
    if (!reason.trim()) { toast.error("Where are you headed?"); return; }
    setBusy(true);
    try {
      await api.post("/escort-attendance/temp-exit", {
        escort_id: escort.id,
        reason: reason.trim(),
        expected_return: computedReturn || null,
      });
      toast.success(`Stepped out — see you by ${computedReturn} 👋`);
      onDone();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-2" data-testid="escort-step-out-form">
      <div className="text-sm font-bold inline-flex items-center gap-2"><Coffee size={14}/> Step out</div>
      <input
        data-testid="escort-step-out-reason"
        placeholder="Where are you headed?"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="iu-input"
        autoFocus
      />
      <div className="grid grid-cols-4 gap-1.5">
        {STEP_OUT_DURATIONS.map((d) => (
          <button
            key={d.min}
            type="button"
            onClick={() => setDurationMin(d.min)}
            data-testid={`escort-step-out-dur-${d.min}`}
            className={`iu-btn ${durationMin === d.min ? "iu-btn-primary" : "iu-btn-secondary"} !h-9 !text-xs`}
          >{d.label}</button>
        ))}
        <button
          type="button"
          onClick={() => setDurationMin(null)}
          className={`iu-btn ${durationMin === null ? "iu-btn-primary" : "iu-btn-secondary"} !h-9 !text-xs`}
        >Custom</button>
      </div>
      {durationMin === null && (
        <input type="time" value={customTime} onChange={(e) => setCustomTime(e.target.value)} className="iu-input" />
      )}
      {computedReturn && (
        <div className="rounded bg-cyan-50/70 border border-cyan-200 px-2 py-1.5 text-[11px] text-cyan-900 inline-flex items-center gap-1.5">
          <Clock size={11}/> Back by <strong>{computedReturn}</strong>
        </div>
      )}
      <div className="flex gap-2">
        <button onClick={onClose} className="iu-btn-secondary flex-1">Cancel</button>
        <button data-testid="escort-step-out-submit" onClick={submit} disabled={busy || !reason.trim()} className="iu-btn-primary flex-1">
          {busy ? <Loader2 className="animate-spin" size={14}/> : "Step out"}
        </button>
      </div>
    </div>
  );
}

function EscortCheckOutForm({ escort, athletes, initialAthleteIds, onClose, onCaptured, onDone }) {
  const sameInst = athletes.filter((a) => (a.institution || "") === (escort.institution || ""));
  const list = sameInst.length > 0 ? sameInst : athletes;
  // Default the checklist to the same athletes the escort had at check-in
  // — assumption is the same kids leave with them. Admin can untick if a
  // sub-set is staying back.
  const [pickedIds, setPickedIds] = useState(new Set(initialAthleteIds || []));
  const [selfie, setSelfie] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggle = (id) => setPickedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/escort-attendance/checkout", {
        escort_id: escort.id,
        athlete_ids: [...pickedIds],
        selfie: selfie || null,
      });
      toast.success(`${escort.name} checked out`);
      // Stash the captured photo locally so the recap screen can show
      // it as a thumbnail straight away.
      if (selfie) onCaptured?.(selfie);
      onDone();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-slate-200 p-3 space-y-3" data-testid="escort-checkout-form">
      <div className="text-sm font-bold inline-flex items-center gap-2"><LogOut size={14}/> Check out</div>
      <div>
        <div className="iu-label">Who&apos;s leaving with you?</div>
        <AthleteCheckboxList list={list} pickedIds={pickedIds} onToggle={toggle} />
      </div>
      <SelfieRow value={selfie} onCapture={() => setShowCamera(true)} onClear={() => setSelfie("")} />
      {showCamera && (
        <SelfieCapture
          onCapture={async (file) => {
            try {
              const dataUrl = await fileToResizedDataUrl(file, 480, 480, 0.7);
              setSelfie(dataUrl);
            } catch (err) { toast.error(err?.message || "Could not save photo"); }
            setShowCamera(false);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
      <div className="flex gap-2">
        <button onClick={onClose} className="iu-btn-secondary flex-1">Cancel</button>
        <button data-testid="escort-checkout-submit" onClick={submit} disabled={busy} className="iu-btn-primary flex-1">
          {busy ? <Loader2 className="animate-spin" size={14}/> : "Check out"}
        </button>
      </div>
    </div>
  );
}

function AthleteCheckboxList({ list, pickedIds, onToggle }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((a) => (a.full_name || "").toLowerCase().includes(needle));
  }, [list, q]);
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="relative border-b border-slate-100">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          data-testid="athlete-checklist-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${list.length} athlete${list.length === 1 ? "" : "s"}…`}
          className="w-full pl-10 pr-3 py-2 text-sm outline-none bg-transparent"
        />
      </div>
      <div className="max-h-56 overflow-y-auto" data-testid="athlete-checklist">
        {filtered.length === 0 ? (
          <div className="text-center text-xs text-slate-500 py-4">No athletes match</div>
        ) : (
          filtered.map((a) => {
            const on = pickedIds.has(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onToggle(a.id)}
                data-testid={`athlete-toggle-${a.id}`}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ${on ? "bg-emerald-50 text-emerald-900" : "hover:bg-slate-50"}`}
              >
                <input type="checkbox" readOnly checked={on} className="accent-emerald-600 shrink-0" />
                <Avatar name={a.full_name} photo={a.photo} size={24} />
                <span className="flex-1 truncate">{a.full_name}</span>
                {a.fleet && <span className="text-[10px] text-slate-400">{a.fleet}</span>}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function SelfieRow({ value, onCapture, onClear }) {
  return (
    <div className="flex items-center gap-2">
      {value ? (
        <div className="flex items-center gap-2 flex-1">
          <img src={value} alt="" className="w-12 h-12 rounded-md object-cover border border-slate-200" data-testid="escort-selfie-preview"/>
          <span className="text-xs text-slate-600 flex-1">Photo captured</span>
          <button type="button" onClick={onClear} className="text-slate-400 hover:text-red-600" data-testid="escort-selfie-clear">
            <X size={14}/>
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onCapture}
          data-testid="escort-selfie-capture"
          className="iu-btn-secondary !text-xs !h-9 flex-1"
        >
          <Camera size={13} /> Add photo (optional)
        </button>
      )}
    </div>
  );
}
