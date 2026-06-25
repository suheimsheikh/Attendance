import React from "react";
import { MemberCard } from "./MemberCard";

export function Column({ col, members, displayList, adminContacts, coachMobile, onSent, onRowDoubleClick, expandedRows, toggleRow }) {
  const Icon = col.icon;
  // Per-category breakdown under the column label so coaches can see
  // "how many Athletes / Coaches / Staff" in each bucket at a glance.
  // Letters keep chips legible inside the narrow 6-column grid.
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
            {members.length}
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
        ) : members.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400">No one here.</div>
        ) : (
          members.map((m) => (
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
          ))
        )}
      </div>
    </section>
  );
}
