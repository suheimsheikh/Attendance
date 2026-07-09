import React, { useMemo } from "react";
import { Tent, Sailboat, Coffee, Globe } from "lucide-react";
import { useEscape } from "../../../hooks/useEscape";
import { useAthleteLikeKeys } from "../../../hooks/useAthleteLikeKeys";
import { formatDate } from "../../../utils";
import { LEVEL_STYLE, scopeLabel } from "./helpers";

/**
 * DayDetailModal — bottom sheet / centered modal opened when the admin
 * clicks a calendar cell that has at least one event. Lists all breaks,
 * camps, and regattas active that day with quick Edit shortcuts.
 *
 * Extracted from Calendar.jsx — pure presentation, no shared state.
 */
export default function DayDetailModal({
  dateKey, dayData, members,
  onClose, onEditRegatta, onEditCamp, onEditBreak,
}) {
  useEscape(onClose);
  const athleteLikeKeys = useAthleteLikeKeys();
  const camps_ = dayData?.camps || [];
  const regs_  = dayData?.regattas || [];
  const breaks_ = dayData?.breaks || [];
  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);

  const headerDate = new Date(dateKey + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Resolve "enrolled count" per camp — explicit member_ids OR all
  // athlete-like members in the institution (mirrors the backend
  // `camp_applies_to` rule). Uses is_athlete_like from the categories
  // master so Elite squad members are counted too (was athlete-only
  // before 04 Feb 2026).
  const enrolledFor = (c) => {
    if ((c.member_ids || []).length) return c.member_ids.length;
    if (c.institution) return members.filter((m) => athleteLikeKeys.has(m.category) && (m.institution || "") === c.institution).length;
    return 0;
  };
  const enrolledMembersFor = (c) => {
    if ((c.member_ids || []).length) {
      return c.member_ids.map((id) => memberById[id]).filter(Boolean);
    }
    if (c.institution) {
      return members.filter((m) => athleteLikeKeys.has(m.category) && (m.institution || "") === c.institution);
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
              {camps_.length} camp{camps_.length === 1 ? "" : "s"} · {breaks_.length} break{breaks_.length === 1 ? "" : "s"} · {regs_.length} regatta{regs_.length === 1 ? "" : "s"} active
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 text-sm">Close</button>
        </header>

        {breaks_.length > 0 && (
          <section className="mb-6">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-amber-700 mb-2 flex items-center gap-1">
              <Coffee size={11} /> Breaks &amp; Holidays
            </h3>
            <div className="space-y-2">
              {breaks_.map((b) => (
                <div key={b.id} data-testid={`day-break-${b.id}`} className="border border-amber-200 bg-amber-50/40 rounded-lg p-3 flex items-center gap-3">
                  <span className="inline-flex items-center px-2 h-5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">{scopeLabel(b)}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 truncate">{b.name}</div>
                    <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3">
                      <span>{formatDate(b.start_date)} → {formatDate(b.end_date)}</span>
                      {b.scope === "selected" && <span>{(b.member_ids || []).length} members</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => onEditBreak(b)}
                    data-testid={`day-break-edit-${b.id}`}
                    className="iu-btn-secondary !px-3 !h-8 text-xs"
                  >
                    Edit
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

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
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold">
                          {count} enrolled
                        </span>
                        <button
                          onClick={() => onEditCamp(c)}
                          data-testid={`day-camp-edit-${c.id}`}
                          className="iu-btn-secondary !px-3 !h-8 text-xs"
                        >
                          Edit
                        </button>
                      </div>
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
                        <span>{formatDate(r.start_date)} → {formatDate(r.end_date)}</span>
                        {r.location && <span className="inline-flex items-center gap-1"><Globe size={10}/>{r.location}{r.country ? `, ${r.country}` : ""}</span>}
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

        {camps_.length === 0 && regs_.length === 0 && breaks_.length === 0 && (
          <div className="py-8 text-center text-sm text-slate-400">Nothing scheduled for this day.</div>
        )}
      </div>
    </div>
  );
}
