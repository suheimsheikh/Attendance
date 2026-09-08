import React, { useEffect, useMemo, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, Plus, Trash2, Edit3, Tent, Sailboat, CalendarDays, Globe, Download, Coffee } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { CampForm } from "./Camps";
import { formatDate } from "../../utils";
import {
  LEVEL_STYLE, LEVELS, DOW_KEYS,
  ymd, startOfMonth, endOfMonth, addMonths, scopeLabel,
} from "./calendar/helpers";
import DayDetailModal from "./calendar/DayDetailModal";
import RegattaForm from "./calendar/RegattaForm";
import BreakFormImpl from "./calendar/BreakForm";

// Re-export so `import { BreakForm } from "./Calendar"` (used by Leaves.jsx)
// keeps working after the extraction.
export const BreakForm = BreakFormImpl;

/**
 * Calendar — admin month view stitching together camps, regattas, and breaks.
 *
 * The 3 leaf modals (DayDetailModal, RegattaForm, BreakForm) + the date
 * helpers + scope constants live in `./calendar/*`. This file now owns
 * the month grid + the bottom CRUD lists + the "Import from YAI" CTA.
 *
 * Net: was 997 lines pre-extraction → ~250 lines parent + 4 leaf files.
 */
export default function Calendar() {
  const [cursor, setCursor] = useState(startOfMonth(new Date()));
  const [camps, setCamps] = useState([]);
  const [regattas, setRegattas] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRegatta, setEditingRegatta] = useState(null);
  const [editingCamp, setEditingCamp] = useState(null);
  const [editingBreak, setEditingBreak] = useState(null);
  const [activeDay, setActiveDay] = useState(null);     // YYYY-MM-DD
  const [members, setMembers] = useState([]);
  const [institutions, setInstitutions] = useState([]);
  const [fleets, setFleets] = useState([]);

  useEffect(() => {
    api.get("/members").then(setMembers).catch(() => {});
    api.get("/institutions").then(setInstitutions).catch(() => {});
    api.get("/fleets").then((rows) => setFleets((rows || []).filter((r) => r.active))).catch(() => {});
  }, []);

  const monthStart = useMemo(() => startOfMonth(cursor), [cursor]);
  const monthEnd = useMemo(() => endOfMonth(cursor), [cursor]);

  const load = async () => {
    setLoading(true);
    try {
      const [c, r, b] = await Promise.all([
        api.get("/camps").catch(() => []),
        api.get("/regattas").catch(() => []),
        api.get("/breaks").catch(() => []),
      ]);
      setCamps(c || []);
      setRegattas(r || []);
      setBreaks(b || []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Map: 'YYYY-MM-DD' → { camps: [...], regattas: [...], breaks: [...] }
  // Camps honour `days_of_week` (per-DOW filter); regattas and breaks
  // expand fully across their date range.
  const byDay = useMemo(() => {
    const days = {};
    for (let dt = new Date(monthStart); dt <= monthEnd; dt.setDate(dt.getDate() + 1)) {
      days[ymd(dt)] = { camps: [], regattas: [], breaks: [] };
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
    for (const b of breaks) {
      if (b.end_date < ymd(monthStart) || b.start_date > ymd(monthEnd)) continue;
      const start = new Date(Math.max(new Date(b.start_date + "T00:00:00"), monthStart));
      const end = new Date(Math.min(new Date(b.end_date + "T00:00:00"), monthEnd));
      for (let dt = new Date(start); dt <= end; dt.setDate(dt.getDate() + 1)) {
        days[ymd(dt)]?.breaks.push(b);
      }
    }
    return days;
  }, [camps, regattas, breaks, monthStart, monthEnd]);

  // 6-row Mon-Sun grid. Start on the Monday on or before monthStart.
  const gridDays = useMemo(() => {
    const first = new Date(monthStart);
    const offset = (first.getDay() + 6) % 7;  // 0=Sun → 6 days back; 1=Mon → 0
    first.setDate(first.getDate() - offset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      return d;
    });
  }, [monthStart]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayKey = ymd(new Date());

  const removeRegatta = async (r) => {
    if (!window.confirm(`Delete regatta "${r.name}"?`)) return;
    try { await api.del(`/regattas/${r.id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };
  const removeCamp = async (c) => {
    if (!window.confirm(`Delete camp "${c.name}"?`)) return;
    try { await api.del(`/camps/${c.id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(err?.message || "Failed"); }
  };
  const removeBreak = async (b) => {
    if (!window.confirm(`Delete break "${b.name}"?`)) return;
    try { await api.del(`/breaks/${b.id}`); toast.success("Deleted"); load(); }
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
            title="Import the official YAI 2026 regatta calendar — updates existing events, adds new ones"
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
          >
            <Download size={16} /> Import from YAI
          </button>
          <button onClick={() => setEditingCamp({})} data-testid="camp-add" title="Create a training camp — attendees show as on tour for those dates" className="iu-btn-secondary !bg-emerald-50 !text-emerald-700 hover:!bg-emerald-100 !border-emerald-200">
            <Tent size={16} /> New camp
          </button>
          <button onClick={() => setEditingBreak({})} data-testid="break-add" title="Declare an academy break — no attendance expected on those days" className="iu-btn-secondary !bg-amber-50 !text-amber-800 hover:!bg-amber-100 !border-amber-200">
            <Coffee size={16} /> Apply break
          </button>
          <button onClick={() => setEditingRegatta({})} data-testid="regatta-add" title="Create a regatta — participants show as on tour for those dates" className="iu-btn-primary">
            <Plus size={16} /> New regatta
          </button>
        </div>
      </header>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mb-3 text-xs">
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-emerald-200" /> Camp</span>
        <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded bg-amber-200" /> Break</span>
        {LEVELS.map((l) => (
          <span key={l} className="inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded" style={{ background: LEVEL_STYLE[l].dot }} />
            {LEVEL_STYLE[l].label} regatta
          </span>
        ))}
      </div>

      {/* Month nav */}
      <div className="flex items-center justify-between mb-2">
        <button onClick={() => setCursor(addMonths(cursor, -1))} className="iu-btn-secondary !px-3 !h-9" data-testid="cal-prev" title="Previous month"><ChevronLeft size={16} /></button>
        <h2 className="text-xl font-bold text-slate-700">{monthLabel}</h2>
        <button onClick={() => setCursor(addMonths(cursor, 1))} className="iu-btn-secondary !px-3 !h-9" data-testid="cal-next" title="Next month"><ChevronRight size={16} /></button>
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
              const breaks_ = dayData?.breaks || [];
              const hasEntries = camps_.length + regs_.length + breaks_.length > 0;
              return (
                <div
                  key={key + "-" + idx}
                  data-testid={`cal-day-${key}`}
                  onClick={() => { if (hasEntries) setActiveDay(key); }}
                  className={`min-h-[88px] border-b border-r border-slate-100 p-1.5 ${inMonth ? "bg-white" : "bg-slate-50/50 text-slate-400"} ${isToday ? "ring-2 ring-sky-400 ring-inset" : ""} ${hasEntries ? "cursor-pointer hover:bg-sky-50" : ""}`}
                >
                  <div className={`text-[11px] font-bold mb-1 ${isToday ? "text-sky-700" : ""}`}>{d.getDate()}</div>
                  <div className="space-y-0.5">
                    {breaks_.slice(0, 2).map((b) => (
                      <div key={"b-" + b.id} title={`Break: ${b.name}`} className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 truncate font-semibold inline-flex items-center gap-1 w-full">
                        <Coffee size={9} /> <span className="truncate">{b.name}</span>
                      </div>
                    ))}
                    {breaks_.length > 2 && (
                      <div className="text-[10px] text-amber-700 font-bold">+{breaks_.length - 2} more</div>
                    )}
                    {camps_.slice(0, 2).map((c) => (
                      <div key={"c-" + c.id} title={`Camp: ${c.name}${c.start_time ? ` · ${c.start_time}–${c.end_time}` : ""}`} className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-800 truncate font-semibold inline-flex items-center gap-1 w-full">
                        <Tent size={9} /> <span className="truncate">{c.name}</span>
                      </div>
                    ))}
                    {camps_.length > 2 && (
                      <div className="text-[10px] text-emerald-700 font-bold">+{camps_.length - 2} more</div>
                    )}
                    {regs_.slice(0, 2).map((r) => {
                      const st = LEVEL_STYLE[r.level] || LEVEL_STYLE.club;
                      return (
                        <div key={"r-" + r.id} title={`${st.label} regatta: ${r.name}${r.location ? ` @ ${r.location}` : ""}`} className={`px-1.5 py-0.5 text-[10px] rounded truncate font-semibold inline-flex items-center gap-1 w-full ${st.chip}`}>
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

      {/* Camps list */}
      <section className="mt-8">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Tent size={16} className="text-emerald-600" /> Camps</h2>
        {camps.length === 0 ? (
          <div className="iu-card p-6 text-center text-sm text-slate-400">No camps yet. Tap <b>New camp</b> at the top to add one.</div>
        ) : (
          <div className="space-y-2">
            {camps.map((c) => (
              <div key={c.id} data-testid={`camp-row-${c.id}`} className="iu-card p-3 flex items-center gap-3">
                <span className="inline-flex items-center px-2 h-5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                  <Tent size={9} className="mr-1" /> Camp
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900 truncate">{c.name}</div>
                  <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{formatDate(c.start_date)} → {formatDate(c.end_date)}</span>
                    <span>{c.start_time} – {c.end_time}</span>
                    {c.institution && <span className="italic">{c.institution}</span>}
                    <span>{c.member_ids?.length ? `${c.member_ids.length} enrolled` : (c.institution ? `all ${c.institution}` : "0 enrolled")}</span>
                  </div>
                </div>
                <button onClick={() => setEditingCamp(c)} data-testid={`camp-edit-${c.id}`} title="Edit this camp's dates and attendees" className="iu-btn-secondary !px-3 !h-9"><Edit3 size={14} /></button>
                <button onClick={() => removeCamp(c)} data-testid={`camp-delete-${c.id}`} title="Delete this camp" className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Breaks list */}
      <section className="mt-8">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Coffee size={16} className="text-amber-600" /> Breaks &amp; Holidays</h2>
        {breaks.length === 0 ? (
          <div className="iu-card p-6 text-center text-sm text-slate-400">No breaks yet. Tap <b>Apply break</b> at the top to mark a rest day or holiday.</div>
        ) : (
          <div className="space-y-2">
            {breaks.map((b) => (
              <div key={b.id} data-testid={`break-row-${b.id}`} className="iu-card p-3 flex items-center gap-3">
                <span className="inline-flex items-center px-2 h-5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">
                  <Coffee size={9} className="mr-1" /> {scopeLabel(b)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900 truncate">{b.name}</div>
                  <div className="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>{formatDate(b.start_date)} → {formatDate(b.end_date)}</span>
                    {b.scope === "institution" && b.institution && <span className="italic">{b.institution}</span>}
                    {b.scope === "selected" && <span>{(b.member_ids || []).length} members</span>}
                  </div>
                </div>
                <button onClick={() => setEditingBreak(b)} data-testid={`break-edit-${b.id}`} title="Edit this break" className="iu-btn-secondary !px-3 !h-9"><Edit3 size={14} /></button>
                <button onClick={() => removeBreak(b)} data-testid={`break-delete-${b.id}`} title="Delete this break" className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Regatta list */}
      <section className="mt-8">
        <h2 className="text-lg font-bold mb-3 flex items-center gap-2"><Sailboat size={16} className="text-violet-600" /> Regattas</h2>
        {regattas.length === 0 ? (
          <div className="iu-card p-6 text-center text-sm text-slate-400">No regattas yet. Add one to see it on the calendar.</div>
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
                      <span>{formatDate(r.start_date)} → {formatDate(r.end_date)}</span>
                      {r.location && <span className="inline-flex items-center gap-1"><Globe size={11} />{r.location}{r.country ? `, ${r.country}` : ""}</span>}
                      {r.host_org && <span className="italic">{r.host_org}</span>}
                    </div>
                  </div>
                  <button onClick={() => setEditingRegatta(r)} data-testid={`regatta-edit-${r.id}`} title="Edit this regatta's dates and participants" className="iu-btn-secondary !px-3 !h-9"><Edit3 size={14} /></button>
                  <button onClick={() => removeRegatta(r)} data-testid={`regatta-delete-${r.id}`} title="Delete this regatta" className="iu-btn-secondary !px-3 !h-9 hover:!bg-rose-50 hover:!text-rose-700"><Trash2 size={14} /></button>
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
      {editingCamp && (
        <CampForm
          initial={editingCamp}
          onClose={() => setEditingCamp(null)}
          onSaved={() => { setEditingCamp(null); load(); }}
        />
      )}
      {editingBreak && (
        <BreakForm
          initial={editingBreak}
          members={members}
          institutions={institutions}
          fleets={fleets}
          onClose={() => setEditingBreak(null)}
          onSaved={() => { setEditingBreak(null); load(); }}
        />
      )}
      {activeDay && (
        <DayDetailModal
          dateKey={activeDay}
          dayData={byDay[activeDay]}
          members={members}
          onClose={() => setActiveDay(null)}
          onEditRegatta={(r) => { setActiveDay(null); setEditingRegatta(r); }}
          onEditCamp={(c) => { setActiveDay(null); setEditingCamp(c); }}
          onEditBreak={(b) => { setActiveDay(null); setEditingBreak(b); }}
        />
      )}
    </div>
  );
}
