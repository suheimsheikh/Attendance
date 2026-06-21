import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, Edit3, Tent, Calendar, Users, MapPin, Sailboat } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useEscape } from "../../hooks/useEscape";
import { formatDate, categoryLabel } from "../../utils";

const WEEKDAYS = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" },
  { key: "sun", label: "Sun" },
];

const TODAY_ISO = new Date().toISOString().slice(0, 10);

export default function Camps() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/camps")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}"?`)) return;
    try { await api.del(`/camps/${r.id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };

  const isLive = (c) => c.start_date <= TODAY_ISO && c.end_date >= TODAY_ISO;

  return (
    <div className="max-w-6xl mx-auto p-6">
      <header className="flex items-end justify-between mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <Tent size={22} className="text-violet-600" /> Camps &amp; Regattas
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Schedule local training <strong>camps</strong> (date range, days &amp; times — enrolled athletes
            are judged against the camp&apos;s times) and <strong>outstation events</strong> — a
            regatta for athletes or a tour for coaches &amp; staff. During an outstation event,
            enrolled members show as “On tour / At regatta” and are never marked absent.
          </p>
        </div>
        <button
          data-testid="camp-add"
          onClick={() => setEditing({})}
          className="iu-btn-primary"
        >
          <Plus size={16} /> New entry
        </button>
      </header>

      {loading ? (
        <div className="py-20 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-400">
          <Tent size={28} className="mx-auto mb-3 opacity-60" />
          <p className="font-semibold text-slate-600">No camps or regattas yet</p>
          <p className="text-sm mt-1">Add a training camp or an outstation regatta/tour to override the default attendance for enrolled members.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => {
            const isOut = c.kind === "outstation";
            return (
            <div
              key={c.id}
              data-testid={`camp-row-${c.id}`}
              className={`iu-card p-4 flex flex-col md:flex-row md:items-center gap-3 ${isLive(c) ? (isOut ? "ring-2 ring-orange-300" : "ring-2 ring-violet-300") : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    data-testid={`camp-kind-${c.id}`}
                    className={`inline-flex items-center gap-1 px-2 h-5 rounded text-[10px] font-bold ${isOut ? "bg-orange-100 text-orange-700" : "bg-emerald-100 text-emerald-700"}`}
                  >
                    {isOut ? <Sailboat size={10} /> : <Tent size={10} />}
                    {isOut ? "Outstation" : "Camp"}
                  </span>
                  <h3 className="font-bold text-slate-900 truncate">{c.name}</h3>
                  {isLive(c) && (
                    <span className="inline-flex items-center px-2 h-5 rounded text-[10px] font-bold bg-violet-100 text-violet-700">LIVE NOW</span>
                  )}
                  {c.institution && (
                    <span className="inline-flex items-center px-2 h-5 rounded text-[10px] font-bold bg-sky-100 text-sky-700">{c.institution}</span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={11} />
                    {formatDate(c.start_date)} → {formatDate(c.end_date)}
                  </span>
                  {c.location && (
                    <span className="inline-flex items-center gap-1 font-semibold text-slate-600" data-testid={`camp-location-${c.id}`}>
                      <MapPin size={11} /> {c.location}
                    </span>
                  )}
                  {!isOut && c.start_time && <span>{c.start_time} – {c.end_time}</span>}
                  {!isOut && (
                    <span>
                      {c.days_of_week?.length
                        ? c.days_of_week.map((d) => WEEKDAYS.find((w) => w.key === d)?.label).join(", ")
                        : "All 7 days"}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Users size={11} />
                    {c.member_ids?.length ? `${c.member_ids.length} enrolled` : (c.institution ? `all ${c.institution}` : "0 enrolled")}
                  </span>
                  {!isOut && c.late_grace_minutes != null && (
                    <span>grace {c.late_grace_minutes}m</span>
                  )}
                </div>
                {c.notes && <p className="text-xs text-slate-400 italic mt-1.5 line-clamp-1">{c.notes}</p>}
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  data-testid={`camp-edit-${c.id}`}
                  onClick={() => setEditing(c)}
                  className="iu-btn-secondary !px-3 !h-9"
                  title="Edit entry"
                >
                  <Edit3 size={14} />
                </button>
                <button
                  data-testid={`camp-delete-${c.id}`}
                  onClick={() => remove(c)}
                  className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700"
                  title="Delete entry"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}

      {editing && (
        <CampForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function CampForm({ initial, onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    name:            initial?.name || "",
    kind:            initial?.kind || "camp",
    location:        initial?.location || "",
    institution:     initial?.institution || "",
    start_date:      initial?.start_date || TODAY_ISO,
    end_date:        initial?.end_date || TODAY_ISO,
    start_time:      initial?.start_time || "06:00",
    end_time:        initial?.end_time || "08:30",
    days_of_week:    initial?.days_of_week || [],
    member_ids:      initial?.member_ids || [],
    late_grace_minutes: initial?.late_grace_minutes ?? "",
    notes:           initial?.notes || "",
  });
  const [members, setMembers] = useState([]);
  const [institutions, setInstitutions] = useState([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.get("/members"), api.get("/institutions").catch(() => [])])
      .then(([m, i]) => { setMembers(m || []); setInstitutions(i || []); })
      .catch(() => {});
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleDay = (d) => set("days_of_week",
    form.days_of_week.includes(d)
      ? form.days_of_week.filter((x) => x !== d)
      : [...form.days_of_week, d]
  );
  const toggleMember = (id) => set("member_ids",
    form.member_ids.includes(id)
      ? form.member_ids.filter((x) => x !== id)
      : [...form.member_ids, id]
  );

  const isOut = form.kind === "outstation";

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return members
      // Camps apply to athletes only; outstation events can enroll anyone
      // (athletes → regatta, coaches & staff → tour).
      .filter((m) => isOut ? true : m.category === "athlete")
      .filter((m) => !form.institution || (m.institution || "") === form.institution)
      .filter((m) => !q || (m.full_name || "").toLowerCase().includes(q));
  }, [members, memberSearch, form.institution, isOut]);

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (form.start_date > form.end_date) { toast.error("Start date must be on or before end date"); return; }
    if (!isOut && form.start_time >= form.end_time) { toast.error("Start time must be before end time"); return; }
    const payload = { ...form };
    // strip empty optional fields so Pydantic validators don't 422
    if (!payload.institution) delete payload.institution;
    if (!payload.location) delete payload.location;
    if (payload.late_grace_minutes === "" || payload.late_grace_minutes == null) {
      delete payload.late_grace_minutes;
    } else {
      payload.late_grace_minutes = Number(payload.late_grace_minutes);
    }
    if (!payload.notes) delete payload.notes;
    // Outstation events don't use times / days / grace.
    if (isOut) {
      delete payload.start_time;
      delete payload.end_time;
      delete payload.days_of_week;
      delete payload.late_grace_minutes;
    }
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/camps/${initial.id}`, payload);
      else        await api.post("/camps", payload);
      toast.success(isEdit ? "Saved" : "Created");
      onSaved?.();
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="camp-form"
        className="bg-white w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl p-6 max-h-[92vh] overflow-y-auto space-y-4"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-xl font-extrabold">{isEdit ? "Edit entry" : "New entry"}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-sm">Close</button>
        </header>

        <div>
          <label className="iu-label">Type</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="cf-kind-camp"
              onClick={() => set("kind", "camp")}
              className={`flex items-start gap-2 p-3 rounded-lg border text-left transition ${!isOut ? "border-emerald-400 bg-emerald-50 ring-1 ring-emerald-300" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <Tent size={16} className={`mt-0.5 ${!isOut ? "text-emerald-600" : "text-slate-400"}`} />
              <span>
                <span className="block text-sm font-bold text-slate-800">Camp</span>
                <span className="block text-[11px] text-slate-500">Local daily training with times — for athletes</span>
              </span>
            </button>
            <button
              type="button"
              data-testid="cf-kind-outstation"
              onClick={() => set("kind", "outstation")}
              className={`flex items-start gap-2 p-3 rounded-lg border text-left transition ${isOut ? "border-orange-400 bg-orange-50 ring-1 ring-orange-300" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <Sailboat size={16} className={`mt-0.5 ${isOut ? "text-orange-600" : "text-slate-400"}`} />
              <span>
                <span className="block text-sm font-bold text-slate-800">Outstation</span>
                <span className="block text-[11px] text-slate-500">Regatta (athletes) / tour (coaches &amp; staff) — auto-excused</span>
              </span>
            </button>
          </div>
        </div>

        <div>
          <label className="iu-label">Name</label>
          <input data-testid="cf-name" value={form.name} onChange={(e) => set("name", e.target.value)} className="iu-input" placeholder={isOut ? "e.g. Sub-Junior National Sailing Championship" : "e.g. Summer Sailing Camp 2026"} />
        </div>

        <div>
          <label className="iu-label">Location {isOut ? "" : "(optional)"}</label>
          <div className="relative">
            <MapPin size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              data-testid="cf-location"
              value={form.location}
              onChange={(e) => set("location", e.target.value)}
              className="iu-input !pl-9"
              placeholder="e.g. Mumbai – Royal Bombay Yacht Club"
            />
          </div>
          {isOut && <p className="text-[11px] text-slate-400 mt-1">Where the regatta / tour is being held — shown on the Presence board.</p>}
        </div>

        <div className={`grid gap-3 ${isOut ? "grid-cols-1" : "grid-cols-2"}`}>
          <div>
            <label className="iu-label">Institution (optional)</label>
            <select data-testid="cf-institution" value={form.institution} onChange={(e) => set("institution", e.target.value)} className="iu-input">
              <option value="">— None (use enrollment) —</option>
              {institutions.map((i) => (
                <option key={i.id || i.name} value={i.name}>{i.name}</option>
              ))}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">If you don&apos;t pick members below, all {isOut ? "members" : "athletes"} from this institution are auto-enrolled.</p>
          </div>
          {!isOut && (
            <div>
              <label className="iu-label">Late grace (minutes, optional)</label>
              <input
                data-testid="cf-grace"
                type="number"
                min={0}
                value={form.late_grace_minutes}
                onChange={(e) => set("late_grace_minutes", e.target.value)}
                className="iu-input"
                placeholder="Office default"
              />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Start date</label>
            <input data-testid="cf-start-date" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">End date</label>
            <input data-testid="cf-end-date" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="iu-input" />
          </div>
          {!isOut && (
            <>
              <div>
                <label className="iu-label">Start time</label>
                <input data-testid="cf-start-time" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} className="iu-input" />
              </div>
              <div>
                <label className="iu-label">End time</label>
                <input data-testid="cf-end-time" type="time" value={form.end_time} onChange={(e) => set("end_time", e.target.value)} className="iu-input" />
              </div>
            </>
          )}
        </div>

        {!isOut && (
        <div>
          <label className="iu-label">Days of week</label>
          <div className="flex gap-1.5 flex-wrap">
            {WEEKDAYS.map((d) => {
              const on = form.days_of_week.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  data-testid={`cf-day-${d.key}`}
                  onClick={() => toggleDay(d.key)}
                  className={`px-3 h-8 rounded-md text-xs font-bold transition ${on ? "bg-violet-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Leave all unselected to run every day in the date range.</p>
        </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5 gap-2 flex-wrap">
            <label className="iu-label !m-0">Enrolled {isOut ? "members" : "athletes"} ({form.member_ids.length})</label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="cf-select-all"
                disabled={filteredMembers.length === 0}
                onClick={() => set("member_ids", Array.from(new Set([...form.member_ids, ...filteredMembers.map((m) => m.id)])))}
                className="px-2 h-7 rounded text-[11px] font-bold bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40 disabled:hover:bg-violet-50"
                title={form.institution ? `Select all visible (${filteredMembers.length})` : "Select all matching the current filter"}
              >
                Select all{form.institution ? ` ${form.institution}` : ""}
              </button>
              <button
                type="button"
                data-testid="cf-deselect-all"
                disabled={form.member_ids.length === 0}
                onClick={() => {
                  const visible = new Set(filteredMembers.map((m) => m.id));
                  set("member_ids", form.member_ids.filter((id) => !visible.has(id)));
                }}
                className="px-2 h-7 rounded text-[11px] font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-slate-100"
                title="Deselect visible athletes"
              >
                Clear visible
              </button>
              <input
                data-testid="cf-member-search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search by name…"
                className="iu-input !h-8 !text-xs !py-1 !w-44"
              />
            </div>
          </div>
          <div className="border border-slate-200 rounded-lg max-h-48 overflow-y-auto divide-y divide-slate-100">
            {filteredMembers.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-slate-400">No {isOut ? "members" : "athletes"} match.</div>
            ) : (
              filteredMembers.map((m) => {
                const on = form.member_ids.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className={`px-3 py-2 flex items-center gap-2 cursor-pointer ${on ? "bg-violet-50" : "hover:bg-slate-50"}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleMember(m.id)}
                      data-testid={`cf-member-${m.id}`}
                    />
                    <span className="text-sm font-medium flex-1 truncate">{m.full_name}</span>
                    {isOut && m.category && m.category !== "athlete" && (
                      <span className="text-[10px] px-1.5 rounded bg-amber-100 text-amber-700 font-semibold">{categoryLabel(m.category)}</span>
                    )}
                    {m.institution && <span className="text-[10px] px-1.5 rounded bg-slate-100 text-slate-600">{m.institution}</span>}
                  </label>
                );
              })
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            {isOut
              ? "Leave empty + pick an institution → everyone from that institution is enrolled. Add coaches & staff here so their tour is recorded too."
              : "Leave empty + pick an institution above → all athletes from that institution are evaluated against the camp."}
          </p>
        </div>

        <div>
          <label className="iu-label">Notes (optional)</label>
          <textarea
            data-testid="cf-notes"
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            className="iu-input"
            rows={2}
            placeholder="Any special instructions or context…"
          />
        </div>

        <footer className="flex gap-2 justify-end pt-2 border-t border-slate-200">
          <button type="button" onClick={onClose} className="iu-btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} data-testid="cf-save" className="iu-btn-primary">
            {saving ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save changes" : (isOut ? "Create event" : "Create camp"))}
          </button>
        </footer>
      </form>
    </div>
  );
}
