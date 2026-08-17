import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Loader2, Plus, Trash2, Edit3, Building2, UserCheck, X, Shield, Ban, History } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";
import { useEscape } from "../../hooks/useEscape";
import { formatDate } from "../../utils";

// Feature flag for the (currently hidden) per-institution Twilio "SMS/Voice
// from" number chips shown on each institution card. All notifications
// go through the Office default sender for now; flip to `true` if we
// ever re-introduce per-institution Twilio sub-numbers.
const SHOW_INST_TWILIO_CHIPS = false;

export default function Institutions() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  // Tracks which institution row is currently showing the escort
  // management panel. Null = none open. Only one open at a time keeps
  // the page compact.
  const [escortsFor, setEscortsFor] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/institutions")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}"?`)) return;
    try {
      await api.del(`/institutions/${r.id}`);
      toast.success("Deleted");
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Institutions</h1>
          <p className="text-slate-500 text-sm mt-1">Master list — appears in member onboarding dropdown.</p>
        </div>
        <button onClick={() => setEditing({})} className="iu-btn-primary" data-testid="new-institution"><Plus size={16}/> Add institution</button>
      </header>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center">
          <Building2 size={32} className="mx-auto text-slate-300 mb-3" />
          <p className="font-semibold">No institutions yet</p>
          <p className="text-sm text-slate-500 mt-1">Add your first one to get the dropdown working in member forms.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="iu-card p-3 flex items-center gap-3 flex-wrap" data-testid={`inst-row-${r.id}`}>
              <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center"><Building2 size={16}/></div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{r.name}</div>
                <div className="text-xs text-slate-500">{r.short_name ? `${r.short_name} · ` : ""}{r.member_count} member{r.member_count === 1 ? "" : "s"}</div>
                {/* Institution-level Twilio chips are temporarily hidden —
                    the app uses the Office default-from-number for every
                    notification. Flip SHOW_INST_TWILIO_CHIPS in the source
                    when per-institution sender numbers are needed again. */}
                {SHOW_INST_TWILIO_CHIPS && (r.sms_from_number || r.voice_from_number) && (
                  <div className="text-[11px] text-emerald-700 font-mono mt-0.5 truncate">
                    {r.sms_from_number ? `SMS ${r.sms_from_number}` : ""}
                    {r.sms_from_number && r.voice_from_number ? "  ·  " : ""}
                    {r.voice_from_number ? `Voice ${r.voice_from_number}` : ""}
                  </div>
                )}
              </div>
              {!r.active && <span className="text-[10px] uppercase font-bold text-slate-400 mr-2">Inactive</span>}
              <button
                onClick={() => setEscortsFor(r)}
                className="iu-btn-secondary !h-9 !px-2.5 !text-xs"
                data-testid={`inst-escorts-${r.id}`}
                title="Manage escorts"
              >
                <UserCheck size={14}/> Escorts
              </button>
              <button onClick={() => setEditing(r)} className="p-2 rounded-lg hover:bg-slate-100" data-testid={`inst-edit-${r.id}`}><Edit3 size={16}/></button>
              <button onClick={() => remove(r)} className="p-2 rounded-lg hover:bg-red-50 text-red-600" data-testid={`inst-delete-${r.id}`}><Trash2 size={16}/></button>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <InstForm
          initial={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {escortsFor && (
        <EscortManager
          institution={escortsFor}
          onClose={() => { setEscortsFor(null); load(); }}
        />
      )}
    </div>
  );
}

/**
 * EscortManager — modal opened from an Institution row. Lists every
 * escort registered against the institution, lets admins add new ones,
 * edit the existing roster (start_date, status, phone), and trigger
 * substitutions (mark old as "replaced", point them at the new escort).
 *
 * Status semantics:
 *   • active   — current escort, eligible to log in / be checked in.
 *   • replaced — historical row; admin pointed `replaced_by` at the new
 *                escort. Kept around so audit trails on attendance
 *                point to the correct historical person.
 *   • left     — escort stopped accompanying anyone. Same audit purpose
 *                as `replaced` but with no incoming substitution.
 */
function EscortManager({ institution, onClose }) {
  useEscape(onClose);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingEsc, setEditingEsc] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get(`/institutions/${institution.id}/escorts`));
    } catch (err) { toast.error(err?.message || "Could not load escorts"); }
    finally { setLoading(false); }
  }, [institution.id]);
  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const g = { active: [], replaced: [], left: [] };
    rows.forEach((r) => { (g[r.status] || (g.active)).push(r); });
    return g;
  }, [rows]);

  return (
    <div className="iu-modal" onClick={(e) => e.target === e.currentTarget && onClose()} data-testid="escort-manager">
      <div className="iu-modal-card max-w-2xl">
        <header className="flex items-start justify-between p-4 border-b border-slate-100">
          <div>
            <div className="text-lg font-extrabold">Escorts · {institution.name}</div>
            <div className="text-xs text-slate-500 mt-0.5">Many escorts can be tied to one institution. Use Substitute to bring in a replacement.</div>
          </div>
          <div className="flex items-center gap-2">
            <button data-testid="add-escort" onClick={() => setShowAdd(true)} className="iu-btn-primary !h-9 !px-3 !text-xs"><Plus size={13}/> Add escort</button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button>
          </div>
        </header>
        <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="text-center py-8"><Loader2 className="mx-auto animate-spin text-slate-400"/></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-8 text-sm text-slate-500">
              No escorts yet — add the first one above.
            </div>
          ) : (
            <>
              <EscortGroup title="Active" rows={groups.active} onEdit={setEditingEsc} onChange={load} accent="emerald" />
              {groups.replaced.length > 0 && <EscortGroup title="Replaced" rows={groups.replaced} onEdit={setEditingEsc} onChange={load} accent="slate" />}
              {groups.left.length > 0 && <EscortGroup title="Left" rows={groups.left} onEdit={setEditingEsc} onChange={load} accent="slate" />}
            </>
          )}
        </div>
      </div>
      {showAdd && (
        <EscortForm
          institutionId={institution.id}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
      {editingEsc && (
        <EscortForm
          institutionId={institution.id}
          initial={editingEsc}
          activeRoster={groups.active}
          onClose={() => setEditingEsc(null)}
          onSaved={() => { setEditingEsc(null); load(); }}
        />
      )}
    </div>
  );
}

function EscortGroup({ title, rows, onEdit, onChange, accent }) {
  if (!rows.length) return null;
  const tone = accent === "emerald" ? "text-emerald-700" : "text-slate-500";
  return (
    <div data-testid={`escort-group-${title.toLowerCase()}`}>
      <div className={`text-[10px] uppercase tracking-wider font-bold ${tone} mb-1.5`}>{title} ({rows.length})</div>
      <div className="space-y-1.5">
        {rows.map((e) => <EscortRow key={e.id} escort={e} onEdit={() => onEdit(e)} onChange={onChange} />)}
      </div>
    </div>
  );
}

function EscortRow({ escort, onEdit, onChange }) {
  const [visits, setVisits] = useState(null);
  const [loadingVisits, setLoadingVisits] = useState(false);
  const [busy, setBusy] = useState(false);

  // Lazy-load recent visits on first expand. Active escorts get a
  // compact strip; we cap to the 5 most recent dates server-side.
  const loadVisits = useCallback(async () => {
    if (visits !== null) return;
    setLoadingVisits(true);
    try {
      const rows = await api.get(`/escorts/${escort.id}/recent-visits?limit=5`);
      setVisits(rows || []);
    } catch (err) {
      // Don't toast — this is opportunistic context, not core flow.
      console.debug("recent-visits failed", err);
      setVisits([]);
    } finally { setLoadingVisits(false); }
  }, [escort.id, visits]);
  useEffect(() => {
    if (escort.status === "active") loadVisits();
  }, [escort.status, loadVisits]);

  const remove = async () => {
    if (!window.confirm(`Delete escort "${escort.name}"? Attendance trail will also be removed.`)) return;
    setBusy(true);
    try {
      await api.del(`/escorts/${escort.id}`);
      toast.success("Deleted");
      onChange();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  const invalidate = async () => {
    if (!window.confirm(`Invalidate ${escort.name}? They can no longer log in or muster — attendance trail is preserved.`)) return;
    setBusy(true);
    try {
      await api.post(`/escorts/${escort.id}/invalidate`, {});
      toast.success(`${escort.name} invalidated`);
      onChange();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  const isActive = escort.status === "active";

  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2" data-testid={`escort-row-${escort.id}`}>
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center"><Shield size={14}/></div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{escort.name}</div>
          <div className="text-[11px] text-slate-500 truncate">
            {escort.phone || "no phone"} · since {formatDate(escort.start_date)}
            {escort.ended_at && ` · ended ${escort.ended_at}`}
          </div>
          {/* Validity window — added 28 Jun 2026. Surfaces the active
              date range so admins can spot expiring escorts at a glance.
              Amber when no end-date is set (legacy backfilled rows). */}
          {(escort.valid_from || escort.valid_until) && (
            <div
              className={`text-[10px] mt-0.5 inline-flex items-center gap-1 ${
                !escort.valid_until ? "text-amber-700" : "text-slate-500"
              }`}
              data-testid={`escort-window-${escort.id}`}
              title={!escort.valid_until ? "Legacy escort — please set Valid-until on next edit" : "Authorised window"}
            >
              <Shield size={9} />
              {escort.valid_from ? formatDate(escort.valid_from) : "?"} → {escort.valid_until ? formatDate(escort.valid_until) : "no end date"}
            </div>
          )}
        </div>
        <button onClick={onEdit} disabled={busy} className="p-1.5 rounded hover:bg-slate-100" data-testid={`escort-edit-${escort.id}`}><Edit3 size={14}/></button>
        {isActive && (
          <button
            onClick={invalidate}
            disabled={busy}
            title="Invalidate (terminal — escort can no longer log in or muster)"
            className="p-1.5 rounded hover:bg-amber-50 text-amber-700"
            data-testid={`escort-invalidate-${escort.id}`}
          >
            <Ban size={14}/>
          </button>
        )}
        <button onClick={remove} disabled={busy} className="p-1.5 rounded hover:bg-red-50 text-red-600" data-testid={`escort-delete-${escort.id}`}><Trash2 size={14}/></button>
      </div>
      {isActive && (
        <RecentVisitsStrip visits={visits} loading={loadingVisits} escortId={escort.id} />
      )}
    </div>
  );
}

function RecentVisitsStrip({ visits, loading, escortId }) {
  if (loading) {
    return (
      <div className="mt-1.5 pl-11 text-[10px] text-slate-400 flex items-center gap-1.5" data-testid={`escort-visits-loading-${escortId}`}>
        <Loader2 size={10} className="animate-spin"/> recent visits…
      </div>
    );
  }
  if (!visits || visits.length === 0) {
    return (
      <div className="mt-1.5 pl-11 text-[10px] text-slate-400 italic" data-testid={`escort-visits-empty-${escortId}`}>
        No visits yet
      </div>
    );
  }
  return (
    <div className="mt-1.5 pl-11 flex items-center gap-1 flex-wrap" data-testid={`escort-visits-${escortId}`}>
      <History size={10} className="text-slate-400 shrink-0"/>
      <span className="text-[10px] uppercase tracking-wider text-slate-400 mr-1">recent</span>
      {visits.map((v, i) => {
        // Convert UTC ISO → local (office TZ) HH:MM. Raw `.slice(11,16)`
        // used to leak UTC into the tooltip.
        const inTime = v.check_in_at
          ? new Date(v.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
          : "—";
        const outTime = v.check_out_at
          ? new Date(v.check_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
          : null;
        return (
          <span
            key={`${v.date}-${i}`}
            title={`In ${inTime}${outTime ? ` · Out ${outTime}` : " · still in"}`}
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${v.check_out_at ? "bg-slate-100 text-slate-600" : "bg-emerald-100 text-emerald-800"}`}
            data-testid={`escort-visit-chip-${escortId}-${i}`}
          >
            {formatVisitDate(v.date)}
          </span>
        );
      })}
    </div>
  );
}

function formatVisitDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso + "T00:00:00");
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = Math.round((today - d) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  } catch { return iso; }
}

function EscortForm({ institutionId, initial, activeRoster = [], onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [phone, setPhone] = useState(initial?.phone || "");
  const [startDate, setStartDate] = useState(initial?.start_date || new Date().toLocaleDateString("sv-SE"));
  // Validity window (added 28 Jun 2026). `valid_from` defaults to the
  // start date when missing on a legacy row; `valid_until` is required
  // on create and when next editing a backfilled escort with null.
  const [validFrom, setValidFrom] = useState(
    initial?.valid_from || initial?.start_date || new Date().toLocaleDateString("sv-SE")
  );
  const [validUntil, setValidUntil] = useState(initial?.valid_until || "");
  const [status, setStatus] = useState(initial?.status || "active");
  const [replacedBy, setReplacedBy] = useState(initial?.replaced_by || "");
  const [busy, setBusy] = useState(false);
  const formErr = useFormError();

  // Legacy rows that pre-date the dates feature carry a null valid_until.
  // When admin opens such a row, force them to pick an end date before
  // they can save — matches the user choice "every escort must have an
  // end date" (2b on 28 Jun).
  const legacyMissingEnd = isEdit && !initial?.valid_until;

  // Replacement dropdown roster — exclude self so an active escort can't
  // "replace" themselves. Memoised so we don't re-filter on every
  // keystroke while the form is being filled out.
  const replacementRoster = useMemo(
    () => activeRoster.filter((a) => a.id !== initial?.id),
    [activeRoster, initial?.id]
  );

  const submit = async (e) => {
    e.preventDefault();
    formErr.clear();
    if (!name.trim()) { formErr.setMessage("Name required"); return; }
    if (!startDate) { formErr.setMessage("Start date required"); return; }
    if (!validFrom) { formErr.setMessage("Valid-from date required"); return; }
    if (!validUntil) {
      formErr.setMessage(legacyMissingEnd
        ? "This escort was added before the dates feature — please set the Valid-until date now."
        : "Valid-until date required");
      return;
    }
    if (validUntil < validFrom) { formErr.setMessage("Valid-until must be on or after Valid-from"); return; }
    setBusy(true);
    try {
      if (isEdit) {
        const body = { name: name.trim(), phone: phone.trim() || null,
                       start_date: startDate,
                       valid_from: validFrom, valid_until: validUntil,
                       status };
        if (status === "replaced") body.replaced_by = replacedBy || null;
        await api.patch(`/escorts/${initial.id}`, body);
      } else {
        await api.post(`/institutions/${institutionId}/escorts`, {
          name: name.trim(), phone: phone.trim() || null, start_date: startDate,
          valid_from: validFrom, valid_until: validUntil,
        });
      }
      toast.success(isEdit ? "Saved" : "Escort added");
      onSaved();
    } catch (err) { formErr.setFromApi(err, "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="iu-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form onSubmit={submit} className="iu-modal-card max-w-md p-5 space-y-3" data-testid="escort-form">
        <div className="flex items-center justify-between">
          <div className="text-lg font-extrabold">{isEdit ? "Edit escort" : "Add escort"}</div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={18}/></button>
        </div>
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="escort-form-name" value={name} onChange={(e) => setName(e.target.value)} className="iu-input" autoFocus />
        </div>
        <div>
          <label className="iu-label">Phone <span className="text-slate-400 normal-case font-normal">(for self check-in via app)</span></label>
          <input data-testid="escort-form-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" className="iu-input"/>
        </div>
        <div>
          <label className="iu-label">Start date</label>
          <input data-testid="escort-form-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="iu-input" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="iu-label">Valid from</label>
            <input
              data-testid="escort-form-valid-from"
              type="date"
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
              className="iu-input"
            />
          </div>
          <div>
            <label className="iu-label">
              Valid until {legacyMissingEnd && <span className="text-amber-600">(please set)</span>}
            </label>
            <input
              data-testid="escort-form-valid-until"
              type="date"
              value={validUntil}
              min={validFrom || undefined}
              onChange={(e) => setValidUntil(e.target.value)}
              className={`iu-input ${legacyMissingEnd ? "border-amber-400 ring-1 ring-amber-200" : ""}`}
            />
          </div>
        </div>
        <div className="text-[11px] text-slate-500 -mt-1">
          The escort can sign in and appear on muster only between these dates. Status stays Active throughout.
        </div>
        {isEdit && (
          <div>
            <label className="iu-label">Status</label>
            <select data-testid="escort-form-status" value={status} onChange={(e) => setStatus(e.target.value)} className="iu-input">
              <option value="active">Active</option>
              <option value="replaced">Replaced (substituted)</option>
              <option value="left">Left</option>
            </select>
            {status === "replaced" && activeRoster.length > 0 && (
              <div className="mt-2">
                <label className="iu-label">Substituted by</label>
                <select data-testid="escort-form-replaced-by" value={replacedBy} onChange={(e) => setReplacedBy(e.target.value)} className="iu-input">
                  <option value="">— pick the replacement —</option>
                  {replacementRoster.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        <FormErrorBanner error={formErr.error} requestId={formErr.requestId} onDismiss={formErr.clear} testId="escort-form-error" />
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="iu-btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={busy} data-testid="escort-form-save" className="iu-btn-primary flex-1">
            {busy ? <Loader2 className="animate-spin" size={14}/> : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function InstForm({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || "");
  const [shortName, setShortName] = useState(initial?.short_name || "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [smsFrom, setSmsFrom] = useState(initial?.sms_from_number || "");
  const [voiceFrom, setVoiceFrom] = useState(initial?.voice_from_number || "");
  const [busy, setBusy] = useState(false);
  const isEdit = !!initial;
  const formErr = useFormError();

  const submit = async (e) => {
    e.preventDefault();
    formErr.clear();
    if (!name.trim()) { formErr.setMessage("Name required"); return; }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        short_name: shortName.trim(),
        active,
        sms_from_number: smsFrom.trim(),
        voice_from_number: voiceFrom.trim(),
      };
      if (isEdit) {
        await api.patch(`/institutions/${initial.id}`, payload);
      } else {
        await api.post("/institutions", payload);
      }
      toast.success("Saved");
      onSaved();
    } catch (err) { formErr.setFromApi(err, "Save failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <h3 className="font-extrabold text-lg">{isEdit ? "Edit" : "Add"} institution</h3>
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="inst-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="iu-input" />
        </div>
        <div>
          <label className="iu-label">Short name <span className="text-slate-400 font-normal normal-case">(optional)</span></label>
          <input data-testid="inst-short" value={shortName} onChange={(e) => setShortName(e.target.value)} className="iu-input" placeholder="e.g. IIT, KIIT" />
        </div>
        {/* Per-institution Twilio sender numbers — disabled for now. The
            app uses the Office Settings default-from-number for every parent
            notification. The fields are intentionally retained (and the
            backend resolution still falls through correctly) so we can
            re-enable per-institution sender branding later without losing
            the wiring. */}
        <div className="pt-2 border-t border-slate-200">
          <p className="text-xs font-bold text-slate-600 uppercase tracking-wide mb-2">
            Twilio sender numbers <span className="text-amber-700 font-normal normal-case ml-1">(disabled — using Office default)</span>
          </p>
          <div>
            <label className="iu-label text-slate-400">SMS &quot;from&quot; number</label>
            <input
              data-testid="inst-sms-from"
              value={smsFrom}
              onChange={(e) => setSmsFrom(e.target.value)}
              disabled
              className="iu-input font-mono text-xs bg-slate-100 text-slate-400 cursor-not-allowed"
              placeholder="Disabled — Office default-from used for all SMS"
              title="Per-institution sender numbers are disabled. The app uses the Office Settings default-from-number for every parent notification."
            />
          </div>
          <div className="mt-2">
            <label className="iu-label text-slate-400">Voice &quot;from&quot; number</label>
            <input
              data-testid="inst-voice-from"
              value={voiceFrom}
              onChange={(e) => setVoiceFrom(e.target.value)}
              disabled
              className="iu-input font-mono text-xs bg-slate-100 text-slate-400 cursor-not-allowed"
              placeholder="Disabled — Office default-from used for all voice calls"
              title="Per-institution sender numbers are disabled. The app uses the Office Settings default-from-number for every voice call."
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer pt-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (show in onboarding dropdown)
        </label>
        <FormErrorBanner
          error={formErr.error}
          requestId={formErr.requestId}
          onDismiss={formErr.clear}
          testId="inst-save-error"
        />
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} className="iu-btn-secondary flex-1">Cancel</button>
          <button type="submit" disabled={busy} className="iu-btn-primary flex-1">{busy ? <Loader2 className="animate-spin" size={14}/> : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
