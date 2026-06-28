import React from "react";
import { Shield, Coffee } from "lucide-react";
import { MemberCard } from "./MemberCard";
import { ExpectedReturnPill } from "./ExpectedReturnPill";
import Avatar from "../Avatar";

export function Column({ col, members, displayList, escorts, adminContacts, coachMobile, onSent, onRowDoubleClick, expandedRows, toggleRow }) {
  const Icon = col.icon;
  const escortList = escorts || [];
  // Per-category breakdown under the column label so coaches can see
  // "how many Athletes / Coaches / Staff" in each bucket at a glance.
  // Letters keep chips legible inside the narrow 6-column grid. Escorts
  // are added as an "E" chip ONLY when this column passes them in,
  // since they're presence-board-relevant only in the Stepped Out
  // column (today).
  const catCounts = { athlete: 0, coach: 0, staff: 0, executive: 0 };
  for (const m of members) {
    const c = (m.category || "athlete").toLowerCase();
    if (catCounts[c] !== undefined) catCounts[c] += 1;
  }
  const breakdown = [
    { key: "athlete",   letter: "A", title: "Athletes",   chip: "bg-sky-100 text-sky-700",         n: catCounts.athlete },
    { key: "coach",     letter: "C", title: "Coaches",    chip: "bg-emerald-100 text-emerald-700", n: catCounts.coach },
    { key: "staff",     letter: "S", title: "Staff",      chip: "bg-amber-100 text-amber-700",     n: catCounts.staff },
    { key: "executive", letter: "E", title: "Executives", chip: "bg-violet-100 text-violet-700",   n: catCounts.executive },
  ];
  if (escortList.length > 0) {
    breakdown.push({
      key: "escort", letter: "Es", title: "Escorts",
      chip: "bg-teal-100 text-teal-700", n: escortList.length,
    });
  }
  // Count badge reflects EVERYONE in this status, members + escorts —
  // so coaches see a single total without having to add two numbers.
  const totalCount = members.length + escortList.length;

  return (
    <section
      className={`flex flex-col rounded-2xl ${col.soft} border border-slate-200 overflow-hidden`}
      data-testid={`presence-column-${col.key}`}
    >
      <header
        className="px-4 py-3 bg-white/70 backdrop-blur border-b border-slate-200"
        style={{ boxShadow: `inset 4px 0 0 ${col.accent}` }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
            style={{ background: col.accent + "20", color: col.accent }}
          >
            <Icon size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500">{col.label}</div>
          </div>
          <span className={`min-w-[26px] h-6 px-2 rounded-full text-xs font-bold flex items-center justify-center ${col.badge}`} data-testid={`column-count-${col.key}`}>
            {totalCount}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid={`column-breakdown-${col.key}`}>
          {breakdown.map((b) => (
            <span
              key={b.key}
              title={`${b.title}: ${b.n}`}
              data-testid={`column-breakdown-${col.key}-${b.key}`}
              className={`inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold tracking-tight ${b.chip} ${b.n === 0 ? "opacity-40" : ""}`}
            >
              <span className="font-extrabold">{b.letter}</span>
              <span className="tabular-nums">{b.n}</span>
            </span>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto max-h-[calc(100vh-220px)] min-h-[120px] divide-y divide-slate-100 bg-white">
        {displayList ? (
          displayList.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-400">No one here.</div>
          ) : (
            displayList.map((entry, idx) => (
              <MemberCard
                key={`${col.key}-${entry.member.id}-${idx}`}
                m={entry.member}
                accent={col.accent}
                columnKey={col.key}
                adminContacts={adminContacts}
                coachMobile={coachMobile}
                onSent={onSent}
                onDoubleClick={entry.visible ? onRowDoubleClick : null}
                hidden={!entry.visible}
                expanded={entry.visible && expandedRows && expandedRows.has(entry.member.id)}
                onToggleExpand={entry.visible && toggleRow ? () => toggleRow(entry.member.id) : null}
              />
            ))
          )
        ) : members.length === 0 && escortList.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400">No one here.</div>
        ) : (
          <>
            {members.map((m) => (
              <MemberCard
                key={m.id}
                m={m}
                accent={col.accent}
                columnKey={col.key}
                adminContacts={adminContacts}
                coachMobile={coachMobile}
                onSent={onSent}
                onDoubleClick={onRowDoubleClick}
                expanded={expandedRows && expandedRows.has(m.id)}
                onToggleExpand={toggleRow ? () => toggleRow(m.id) : null}
              />
            ))}
            {escortList.length > 0 && (
              <EscortRowsSection escorts={escortList} accent={col.accent} columnKey={col.key} />
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * EscortRowsSection — compact escort rows appended at the bottom of a
 * presence column. Currently only used by the Stepped Out column (the
 * only status escorts have a meaningful representation in alongside
 * members). Keeps the visual distinction from members via the teal
 * Shield rail at the top of the section.
 */
function EscortRowsSection({ escorts, accent, columnKey }) {
  return (
    <div data-testid={`column-escorts-${columnKey}`}>
      <div className="px-4 py-1.5 bg-teal-50/60 border-y border-teal-200 flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-teal-700">
        <Shield size={10} /> Escorts
        <span className="ml-auto px-1.5 h-4 rounded bg-teal-200 text-teal-800 tabular-nums">
          {escorts.length}
        </span>
      </div>
      {escorts.map((e) => {
        const inAt = e.check_in_at
          ? new Date(e.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—";
        const outAt = e.check_out_at
          ? new Date(e.check_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : null;
        // Exited rows show "In HH:MM → Out HH:MM"; on-campus/temp-out
        // rows show "since HH:MM" (matches the strip wording).
        const timeLine = outAt ? `In ${inAt} → Out ${outAt}` : `since ${inAt}`;
        return (
          <div
            key={e.attendance_id || e.escort_id}
            className="px-4 py-2 flex items-center gap-3"
            data-testid={`column-escort-row-${e.escort_id}`}
          >
            <Avatar name={e.name} photo={e.photo} size={28} ring={accent} />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-slate-900 truncate leading-tight">{e.name}</div>
              <div className="text-[10px] text-slate-500 truncate leading-tight">
                {e.institution || "no institution"} · {timeLine}
              </div>
              <div className="flex flex-wrap gap-1 mt-0.5">
                <ExpectedReturnPill
                  expectedReturnTime={e.expected_return_time}
                  expectedReturnIso={e.expected_return}
                  overdueMinutes={e.overdue_minutes}
                  testId={`column-escort-due-${e.escort_id}`}
                />
                {e.temp_out_reason && (
                  <span className="text-[10px] text-cyan-700 truncate inline-flex items-center gap-1">
                    <Coffee size={9}/> {e.temp_out_reason}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
