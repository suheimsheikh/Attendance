import React, { useEffect, useMemo, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, Plus, Trash2, Edit3, Tent, Sailboat, CalendarDays, Globe, Download } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useEscape } from "../../hooks/useEscape";

const LEVEL_STYLE = {
  international: { chip: "bg-violet-100 text-violet-700",   dot: "#7C3AED", label: "International" },
  national:      { chip: "bg-amber-100 text-amber-700",     dot: "#D97706", label: "National" },
  state:         { chip: "bg-sky-100 text-sky-700",         dot: "#0284C7", label: "State" },
  club:          { chip: "bg-slate-200 text-slate-700",     dot: "#475569", label: "Club" },
};
const LEVELS = ["international", "national", "state", "club"];

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

// Camp days-of-week filter — backend stores ["mon","tue",…]. JS getDay() is 0=Sun.
const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export default function Calendar() {
  const [cursor, setCursor] = useState(startOfMonth(new Date()));
  const [camps, setCamps] = useState([]);
  const [regattas, setRegattas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRegatta, setEditingRegatta] = useState(null);
  const [activeDay, setActiveDay] = useState(null);     // YYYY-MM-DD
  const [members, setMembers] = useState([]);

  useEffect(() => {
    api.get("/members").then(setMembers).catch(() => {});
  }, []);

  const monthStart = useMemo(() => startOfMonth(cursor), [cursor]);
  const monthEnd = useMemo(() => endOfMonth(cursor), [cursor]);

  const load = async () => {
    setLoading(true);
    try {
      const [c, r] = await Promise.all([
        api.get("/camps").catch(() => []),
        api.get("/regattas").catch(() => []),
      ]);
      setCamps(c || []);
      setRegattas(r || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Map: 'YYYY-MM-DD' → { camps: [...], regattas: [...] }
  const byDay = useMemo(() => {
    const days = {};
    for (let dt = new Date(monthStart); dt <= monthEnd; dt.setDate(dt.getDate() + 1)) {
      const key = ymd(dt);
      days[key] = { camps: [], regattas: [] };
    }
    for (const c of camps) {
      if (c.end_date < ymd(monthStart) || c.start_date > ymd(monthEnd)) continue;
      const restrictDows = (c.days_of_week || []).length > 0;
      const start = new Date(Math.max(new Date(c.start_date + "T00:00:00"), monthStart));
      const end = new Date(Math.min(new Date(c.end_date + "T00:00:00"), monthEnd));
      for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
        if (restrictDows && !c.days_of_week.includes(DOW_KEYS[dt.getDay()])) continue;
        days[ymd(dt)]?.camps.push(c);
      }
    }
    for (const r of regattas) {
      if (r.end_date < ymd(monthStart) || r.start_date > ymd(monthEnd)) continue;
      const start = new Date(Math.max(new Date(r.start_date + "T00:00:00"), monthStart));
      const end = new Date(Math.min(new Date(r.end_date + "T00:00:00"), monthEnd));
      for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
        days[ymd(dt)]?.regattas.push(r);
      }
    }
    return days;
  }, [camps, regattas, monthStart, monthEnd]);

  // Build the 6-row grid (Mon-Sun). Start on the Monday on or before monthStart.
  const gridDays = useMemo(() => {
    const first = new Date(monthStart);
    // 0=Sun -> 6 days back; 1=Mon -> 0; etc.
    const offset = (first.getDay() + 6) % 7;
    first.setDate(first.getDate() - offset);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      cells.push(d);
    }
    return cells;
  }, [monthStart]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayKey = ymd(new Date());

  const removeRegatta = async (r) => {
    if (!window.confirm(`Delete regatta "${r.name}"?`)) return;
    try { await api.del(`/regattas/${r.id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };

  return (
    <div className="max-w-7xl mx-auto p-6">
      <header className="flex flex-wrap items-end justify-between mb-6 gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <CalendarDays size={22} className="text-sky-600" /> Calendar
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Camps and regattas at a glance. Switch months with the arrows; click a regatta below to edit.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={async () => {
              if (!window.confirm("Import the YAI 2026 sailing calendar?\n\nAlready-present events will be updated, new ones added. No existing data is deleted.")) return;
              try {
                const res = await api.post("/regattas/import-yai");
                toast.success(`YAI calendar synced — ${res.inserted} new, ${res.updated} updated`);
                load();
              } catch (err) { toast.error(err?.message || "Import failed"); }
            }}
            data-testid="yai-import"
            className="iu-btn-secondary"
            title="Import / refresh the Yachting Association of India 2026 domestic calendar"
          >
            <Download size={16} /> Import from YAI
          </button>
          <button
            onClick={() => setEditingRegatta({})}
            data-testid="regatta-add"
            className="iu-btn-primary"
          >
            <Plus size={16} /> New regatta
          </button>
        </div>
      </header>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-emerald-200" /> Camp</span>
        {LEVELS.map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded" style={{ background: LEVEL_STYLE[l].dot }} />
            {LEVEL_STYLE[l].label} regatta
          </span>
        ))}
      </div>

      {/* Month nav */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setCursor(addMonths(cursor, -1))} className="iu-btn-secondary !px-3 !h-9" data-testid="cal-prev"><ChevronLeft size={16} /></button>
        <h2 className="text-xl font-bold text-slate-700">{monthLabel}</h2>
        <button onClick={() => setCursor(addMonths(cursor, 1))} className="iu-btn-secondary !px-3 !h-9" data-testid="cal-next"><ChevronRight size={16} /></button>
      </div>

      {loading ? (
        <div className="py-20 flex justify-center text-slate-400"><Loader2 className="animate-spin" size={20} /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          {/* Day-of-week header */}
          <div className="grid grid-cols-7 bg-slate-50 border-b border-slate-200">
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
              <div key={d} className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500 text-center">{d}</div>
            ))}
          </div>
          {/* Grid */}
          <div className="grid grid-cols-7" data-testid="calendar-grid">
            {gridDays.map((d, idx) => {
              const key = ymd(d);
              const inMonth = d.getMonth() === cursor.getMonth();
              const isToday = key === todayKey;
              const dayData = byDay[key];
              const camps_ = dayData?.camps || [];
              const regs_  = dayData?.regattas || [];
              const hasEntries = camps_.length + regs_.length > 0;
              return (
                <div
                  key={key + "-" + idx}
                  data-testid={`cal-day-${key}`}
                  onClick={() => { if (hasEntries) setActiveDay(key); }}
                  className={`min-h-[88px] border-b border-r border-slate-100 p-1.5 ${inMonth ? "bg-white" : "bg-slate-50/50 text-slate-400"} ${isToday ? "ring-2 ring-sky-400 ring-inset" : ""} ${hasEntries ? "cursor-pointer hover:bg-sky-50" : ""}`}
                >
                  <div className={`text-[11px] font-bold mb-1 ${isToday ? "text-sky-700" : ""}`}>{d.getDate()}</div>
                  <div className="space-y-0.5">
                    {camps_.slice(0, 2).map((c) => (
                      <div
                        key={"c-" + c.id}
                        title={`Camp: ${c.name}${c.start_time ? ` · ${c.start_time}–${c.end_time}` : ""}`}
                        className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-800 truncate font-semibold inline-flex items-center gap-1 w-full"
                      >
                        <Tent size={9} /> <span className="truncate">{c.name}</span>
                      </div>
                    ))}
                    {camps_.length > 2 && (
                      <div className="text-[10px] text-emerald-700 font-bold">+{camps_.length - 2} more</div>
                    )}
                    {regs_.slice(0, 2).map((r) => {
                      const st = LEVEL_STYLE[r.level] || LEVEL_STYLE.club;
                      return (
                        <div
                          key={"r-" + r.id}
                          title={`${st.label} regatta: ${r.name}${r.location ? ` @ ${r.location}` : ""}`}
                          className={`px-1.5 py-0.5 text-[10px] rounded truncate font-semibold inline-flex items-center gap-1 w-full ${st.chip}`}
                        >
                          <Sailboat size={9} /> <span className="truncate">{r.name}</span>
                        </div>
                      );
                    })}
                    {regs_.length > 2 && (
                      <div className="text-[10px] font-bold text-slate-500">+{regs_.length - 2} more</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Regatta list */}
      <section className="mt-8">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Sailboat size={16} className="text-violet-600" /> Regattas</h2>
        {regattas.length === 0 ? (
          <div className="iu-card p-6 text-center text-sm text-slate-400">
            No regattas yet. Add one to see it on the calendar.
          </div>
        ) : (
          <div className="space-y-2">
            {regattas.map((r) => {
              const st = LEVEL_STYLE[r.level] || LEVEL_STYLE.club;
              return (
                <div key={r.id} data-testid={`regatta-row-${r.id}`} className="iu-card p-3 flex items-center gap-3">
                  <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold ${st.chip}`}>{st.label}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 truncate">{r.name}</div>
                    <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span>{r.start_date} → {r.end_date}</span>
                      {r.location && <span className="inline-flex items-center gap-1"><Globe size={11} />{r.location}{r.country ? `, ${r.country}` : ""}</span>}
                      {r.host_org && <span className="italic">{r.host_org}</span>}
                    </div>
                  </div>
                  <button onClick={() => setEditingRegatta(r)} data-testid={`regatta-edit-${r.id}`} className="iu-btn-secondary !px-3 !h-9"><Edit3 size={14} /></button>
                  <button onClick={() => removeRegatta(r)} data-testid={`regatta-delete-${r.id}`} className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700"><Trash2 size={14} /></button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {editingRegatta && (
        <RegattaForm
          initial={editingRegatta}
          onClose={() => setEditingRegatta(null)}
          onSaved={() => { setEditingRegatta(null); load(); }}
        />
      )}
      {activeDay && (
        <DayDetailModal
          dateKey={activeDay}
          dayData={byDay[activeDay]}
          members={members}
          onClose={() => setActiveDay(null)}
          onEditRegatta={(r) => { setActiveDay(null); setEditingRegatta(r); }}
        />
      )}
    </div>
  );
}

function DayDetailModal({ dateKey, dayData, members, onClose, onEditRegatta }) {
  useEscape(onClose);
  const camps_ = dayData?.camps || [];
  const regs_  = dayData?.regattas || [];
  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);

  const headerDate = new Date(dateKey + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Resolve "enrolled count" per camp — explicit member_ids OR all athletes in
  // the institution (mirrors the backend `camp_applies_to` rule).
  const enrolledFor = (c) => {
    if ((c.member_ids || []).length) return c.member_ids.length;
    if (c.institution) return members.filter((m) => m.category === "athlete" && (m.institution || "") === c.institution).length;
    return 0;
  };
  const enrolledMembersFor = (c) => {
    if ((c.member_ids || []).length) {
      return c.member_ids.map((id) => memberById[id]).filter(Boolean);
    }
    if (c.institution) {
      return members.filter((m) => m.category === "athlete" && (m.institution || "") === c.institution);
    }
    return [];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="day-detail-modal"
        className="bg-white w-full md:max-w-2xl rounded-t-2xl md:rounded-2xl p-6 max-h-[92vh] overflow-y-auto"
      >
        <header className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-extrabold">{headerDate}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {camps_.length} camp{camps_.length === 1 ? "" : "s"} · {regs_.length} regatta{regs_.length === 1 ? "" : "s"} active
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-sm">Close</button>
        </header>

        {camps_.length > 0 && (
          <section className="mb-6">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 mb-2 flex items-center gap-1">
              <Tent size={11} /> Camps
            </h3>
            <div className="space-y-2">
              {camps_.map((c) => {
                const count = enrolledFor(c);
                const sampleMembers = enrolledMembersFor(c).slice(0, 6);
                return (
                  <div key={c.id} data-testid={`day-camp-${c.id}`} className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-bold text-slate-900">{c.name}</div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                        {count} enrolled
                      </span>
                    </div>
                    <div className="text-xs text-slate-600 mt-1 flex flex-wrap gap-x-3">
                      <span>{c.start_time} – {c.end_time}</span>
                      {c.institution && <span className="font-semibold">{c.institution}</span>}
                      {c.late_grace_minutes != null && <span>grace {c.late_grace_minutes}m</span>}
                    </div>
                    {sampleMembers.length > 0 && (
                      <div className="text-[11px] text-slate-500 mt-2">
                        {sampleMembers.map((m) => m.full_name).join(", ")}
                        {count > sampleMembers.length && <> + {count - sampleMembers.length} more</>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {regs_.length > 0 && (
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-violet-700 mb-2 flex items-center gap-1">
              <Sailboat size={11} /> Regattas
            </h3>
            <div className="space-y-2">
              {regs_.map((r) => {
                const st = LEVEL_STYLE[r.level] || LEVEL_STYLE.club;
                return (
                  <div key={r.id} data-testid={`day-regatta-${r.id}`} className="border border-slate-200 rounded-lg p-3 flex items-center gap-3">
                    <span className={`inline-flex items-center px-2 h-5 rounded text-[10px] font-bold ${st.chip}`}>{st.label}</span>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-900 truncate">{r.name}</div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3">
                        <span>{r.start_date} → {r.end_date}</span>
                        {r.location && <span>{r.location}{r.country ? `, ${r.country}` : ""}</span>}
                        {r.host_org && <span className="italic">{r.host_org}</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => onEditRegatta(r)}
                      data-testid={`day-regatta-edit-${r.id}`}
                      className="iu-btn-secondary !px-3 !h-8 text-xs"
                    >
                      Edit
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {camps_.length === 0 && regs_.length === 0 && (
          <div className="py-8 text-center text-sm text-slate-400">Nothing scheduled for this day.</div>
        )}
      </div>
    </div>
  );
}

function RegattaForm({ initial, onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial?.id;
  const today = ymd(new Date());
  const [form, setForm] = useState({
    name:        initial?.name || "",
    level:       initial?.level || "national",
    location:    initial?.location || "",
    country:     initial?.country || "",
    start_date:  initial?.start_date || today,
    end_date:    initial?.end_date || today,
    host_org:    initial?.host_org || "",
    notes:       initial?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e?.preventDefault?.();
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (form.start_date > form.end_date) { toast.error("Start must be on or before end"); return; }
    const payload = { ...form };
    Object.keys(payload).forEach((k) => { if (payload[k] === "") delete payload[k]; });
    setSaving(true);
    try {
      if (isEdit) await api.patch(`/regattas/${initial.id}`, payload);
      else        await api.post("/regattas", payload);
      toast.success(isEdit ? "Updated" : "Created");
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
        data-testid="regatta-form"
        className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <h2 className="text-xl font-extrabold">{isEdit ? "Edit regatta" : "New regatta"}</h2>
        <div>
          <label className="iu-label">Name</label>
          <input data-testid="rf-name" value={form.name} onChange={(e) => set("name", e.target.value)} className="iu-input" placeholder="e.g. 49er World Championship 2026" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="iu-label">Level</label>
            <select data-testid="rf-level" value={form.level} onChange={(e) => set("level", e.target.value)} className="iu-input">
              {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_STYLE[l].label}</option>)}
            </select>
          </div>
          <div>
            <label className="iu-label">Host org (optional)</label>
            <input data-testid="rf-host" value={form.host_org} onChange={(e) => set("host_org", e.target.value)} className="iu-input" placeholder="World Sailing, YAI…" />
          </div>
          <div>
            <label className="iu-label">Location</label>
            <input data-testid="rf-location" value={form.location} onChange={(e) => set("location", e.target.value)} className="iu-input" placeholder="Auckland" />
          </div>
          <div>
            <label className="iu-label">Country</label>
            <input data-testid="rf-country" value={form.country} onChange={(e) => set("country", e.target.value)} className="iu-input" placeholder="New Zealand" />
          </div>
          <div>
            <label className="iu-label">Start date</label>
            <input data-testid="rf-start" type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} className="iu-input" />
          </div>
          <div>
            <label className="iu-label">End date</label>
            <input data-testid="rf-end" type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="iu-input" />
          </div>
        </div>
        <div>
          <label className="iu-label">Notes (optional)</label>
          <textarea data-testid="rf-notes" rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} className="iu-input" placeholder="Travel info, points of contact…" />
        </div>
        <footer className="flex gap-2 justify-end pt-2 border-t border-slate-200">
          <button type="button" onClick={onClose} className="iu-btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} data-testid="rf-save" className="iu-btn-primary">
            {saving ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save" : "Create")}
          </button>
        </footer>
      </form>
    </div>
  );
}
