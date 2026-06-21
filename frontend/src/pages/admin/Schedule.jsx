import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, Edit3, CalendarOff, Clock, Sun, Save, PartyPopper } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useEscape } from "../../hooks/useEscape";
import { formatDate } from "../../utils";

const WEEKDAYS = [
  { key: "mon", label: "Monday" }, { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" }, { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" }, { key: "sat", label: "Saturday" },
  { key: "sun", label: "Sunday" },
];

const TODAY_ISO = new Date().toISOString().slice(0, 10);

export default function Schedule() {
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
          <Clock size={22} className="text-violet-600" /> Schedule &amp; Holidays
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Shift start times for specific weekdays, change a single day&apos;s timings, and mark holidays.
          These campus-wide overrides take precedence over camps and personal schedules for that day.
        </p>
      </header>
      <WeeklyOverrides />
      <Exceptions />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Weekly recurring overrides                                          */
/* ------------------------------------------------------------------ */
function WeeklyOverrides() {
  const [rows, setRows] = useState({}); // { sun: {start_time, end_time}, ... }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/schedule/weekly");
      setRows(res?.overrides || {});
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setDay = (key, field, val) => {
    setRows((r) => {
      const next = { ...r };
      const cur = { ...(next[key] || {}) };
      cur[field] = val;
      if (!cur.start_time && !cur.end_time) delete next[key];
      else next[key] = cur;
      return next;
    });
  };

  const save = async () => {
    // Only days with a start_time are meaningful overrides.
    const clean = {};
    for (const [k, v] of Object.entries(rows)) {
      if (v?.start_time) clean[k] = { start_time: v.start_time, end_time: v.end_time || "" };
    }
    setSaving(true);
    try {
      const res = await api.put("/schedule/weekly", { overrides: clean });
      setRows(res?.overrides || {});
      toast.success("Weekly schedule saved");
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <section className="iu-card p-5" data-testid="weekly-overrides">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2"><Sun size={16} className="text-amber-500" /> Weekly timing overrides</h2>
          <p className="text-xs text-slate-500 mt-0.5">e.g. every <strong>Sunday</strong> start at <strong>08:00</strong> instead of 06:00. Leave a day blank to use the normal schedule.</p>
        </div>
        <button data-testid="weekly-save" onClick={save} disabled={saving} className="iu-btn-primary !h-9">
          {saving ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />} Save
        </button>
      </div>
      {loading ? (
        <div className="py-8 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>
      ) : (
        <div className="divide-y divide-slate-100">
          {WEEKDAYS.map((d) => {
            const v = rows[d.key] || {};
            const on = !!v.start_time;
            return (
              <div key={d.key} data-testid={`weekly-row-${d.key}`} className="flex items-center gap-3 py-2.5">
                <div className={`w-28 text-sm font-semibold ${on ? "text-slate-900" : "text-slate-400"}`}>{d.label}</div>
                <label className="text-[11px] text-slate-500">Start</label>
                <input
                  type="time"
                  data-testid={`weekly-start-${d.key}`}
                  value={v.start_time || ""}
                  onChange={(e) => setDay(d.key, "start_time", e.target.value)}
                  className="iu-input !h-9 !w-32"
                />
                <label className="text-[11px] text-slate-500">End</label>
                <input
                  type="time"
                  data-testid={`weekly-end-${d.key}`}
                  value={v.end_time || ""}
                  onChange={(e) => setDay(d.key, "end_time", e.target.value)}
                  className="iu-input !h-9 !w-32"
                />
                {on && (
                  <button
                    type="button"
                    data-testid={`weekly-clear-${d.key}`}
                    onClick={() => setRows((r) => { const n = { ...r }; delete n[d.key]; return n; })}
                    className="text-xs text-slate-400 hover:text-rose-600 ml-auto"
                  >
                    Clear
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Holidays & one-off timing exceptions                                */
/* ------------------------------------------------------------------ */
function Exceptions() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/schedule/exceptions")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name || r.kind}"?`)) return;
    try { await api.del(`/schedule/exceptions/${r.id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };

  const upcoming = useMemo(
    () => [...rows].sort((a, b) => (a.start_date < b.start_date ? 1 : -1)),
    [rows]
  );

  return (
    <section data-testid="exceptions-section">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2"><PartyPopper size={16} className="text-rose-500" /> Holidays &amp; one-off changes</h2>
          <p className="text-xs text-slate-500 mt-0.5">Mark holidays (no one expected, never marked absent) or change a specific date&apos;s timings.</p>
        </div>
        <button data-testid="exception-add" onClick={() => setEditing({})} className="iu-btn-primary">
          <Plus size={16} /> New entry
        </button>
      </div>

      {loading ? (
        <div className="py-12 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : upcoming.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-400">
          <CalendarOff size={26} className="mx-auto mb-3 opacity-60" />
          <p className="font-semibold text-slate-600">No holidays or timing changes yet</p>
          <p className="text-sm mt-1">Add a holiday or a one-off timing change for a specific date.</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {upcoming.map((r) => {
            const isHol = r.kind === "holiday";
            const range = r.start_date === r.end_date ? formatDate(r.start_date) : `${formatDate(r.start_date)} → ${formatDate(r.end_date)}`;
            return (
              <div key={r.id} data-testid={`exception-row-${r.id}`} className="iu-card p-4 flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${isHol ? "bg-rose-100 text-rose-600" : "bg-sky-100 text-sky-600"}`}>
                  {isHol ? <CalendarOff size={16} /> : <Clock size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold ${isHol ? "bg-rose-100 text-rose-700" : "bg-sky-100 text-sky-700"}`}>
                      {isHol ? "Holiday" : "Timing change"}
                    </span>
                    <h3 className="font-bold text-slate-900 truncate">{r.name || (isHol ? "Holiday" : "Timing change")}</h3>
                  </div>
                  <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3">
                    <span>{range}</span>
                    {!isHol && r.start_time && <span className="font-semibold text-slate-600">{r.start_time}{r.end_time ? ` – ${r.end_time}` : ""}</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button data-testid={`exception-edit-${r.id}`} onClick={() => setEditing(r)} className="iu-btn-secondary !px-3 !h-9" title="Edit"><Edit3 size={14} /></button>
                  <button data-testid={`exception-delete-${r.id}`} onClick={() => remove(r)} className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700" title="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ExceptionForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </section>
  );
}

function ExceptionForm({ initial, onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    kind:       initial?.kind || "holiday",
    name:       initial?.name || "",
    start_date: initial?.start_date || TODAY_ISO,
    end_date:   initial?.end_date || TODAY_ISO,
    start_time: initial?.start_time || "08:00",
    end_time:   initial?.end_time || "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isHol = form.kind === "holiday";

  const submit = async (e) => {
    e?.preventDefault?.();
    if (form.start_date > form.end_date) { toast.error("Start date must be on or before end date"); return; }
    if (!isHol && !form.start_time) { toast.error("Timing changes need a start time"); return; }
    const payload = {
      kind: form.kind,
      name: form.name?.trim() || null,
      start_date: form.start_date,
      end_date: form.end_date,
    };
    if (!isHol) {
      payload.start_time = form.start_time;
      payload.end_time = form.end_time || null;
    }
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/schedule/exceptions/${initial.id}`, payload);
      else        await api.post("/schedule/exceptions", payload);
      toast.success(isEdit ? "Saved" : "Created");
      onSaved?.();
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="exception-form"
        className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-6 max-h-[92vh] overflow-y-auto space-y-4"
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
              data-testid="ef-kind-holiday"
              onClick={() => set("kind", "holiday")}
              className={`flex items-start gap-2 p-3 rounded-lg border text-left transition ${isHol ? "border-rose-400 bg-rose-50 ring-1 ring-rose-300" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <CalendarOff size={16} className={`mt-0.5 ${isHol ? "text-rose-600" : "text-slate-400"}`} />
              <span>
                <span className="block text-sm font-bold text-slate-800">Holiday</span>
                <span className="block text-[11px] text-slate-500">No one expected — never marked absent</span>
              </span>
            </button>
            <button
              type="button"
              data-testid="ef-kind-timing"
              onClick={() => set("kind", "timing")}
              className={`flex items-start gap-2 p-3 rounded-lg border text-left transition ${!isHol ? "border-sky-400 bg-sky-50 ring-1 ring-sky-300" : "border-slate-200 hover:bg-slate-50"}`}
            >
              <Clock size={16} className={`mt-0.5 ${!isHol ? "text-sky-600" : "text-slate-400"}`} />
              <span>
                <span className="block text-sm font-bold text-slate-800">Timing change</span>
                <span className="block text-[11px] text-slate-500">Different start/end time for a date</span>
              </span>
            </button>
          </div>
        </div>

        <div>
          <label className="iu-label">Name {isHol ? "" : "(optional)"}</label>
          <input data-testid="ef-name" value={form.name} onChange={(e) => set("name", e.target.value)} className="iu-input" placeholder={isHol ? "e.g. Bonalu, Republic Day" : "e.g. Regatta prep — early start"} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Start date</label>
            <input data-testid="ef-start-date" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">End date</label>
            <input data-testid="ef-end-date" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="iu-input" />
            <p className="text-[11px] text-slate-400 mt-1">Same as start for a single day. Use a range for e.g. 25 Dec – 1 Jan.</p>
          </div>
          {!isHol && (
            <>
              <div>
                <label className="iu-label">Start time</label>
                <input data-testid="ef-start-time" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} className="iu-input" />
              </div>
              <div>
                <label className="iu-label">End time (optional)</label>
                <input data-testid="ef-end-time" type="time" value={form.end_time} onChange={(e) => set("end_time", e.target.value)} className="iu-input" />
              </div>
            </>
          )}
        </div>

        <footer className="flex gap-2 justify-end pt-2 border-t border-slate-200">
          <button type="button" onClick={onClose} className="iu-btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} data-testid="ef-save" className="iu-btn-primary">
            {saving ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save changes" : "Create")}
          </button>
        </footer>
      </form>
    </div>
  );
}
