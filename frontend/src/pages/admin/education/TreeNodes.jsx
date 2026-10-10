import React from "react";
import { ChevronRight, FileText, Pencil, Plus, Trash2, UserCog, Eye } from "lucide-react";
import { MONTHS } from "./MarksheetModal";

const Chevron = ({ open }) => <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />;
const iconBtn = "h-7 px-2 rounded-md text-xs font-semibold inline-flex items-center gap-1 transition-colors";

function SheetRow({ s, onView, onEdit, onDelete }) {
  const tid = `sheet-${s.id}`;
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 pl-3 pr-2 rounded-lg hover:bg-slate-50" data-testid={tid}>
      <FileText size={14} className="text-slate-400" />
      <span className="font-mono text-xs w-16 text-slate-600" data-testid={`${tid}-when`}>{MONTHS[s.month - 1]} {s.year}</span>
      <span className="font-semibold text-sm">{s.exam_name}</span>
      {s.board && <span className="text-xs text-slate-500">· {s.board}</span>}
      {s.result && <span className="text-xs font-semibold text-sky-700">· {s.result}</span>}
      {s.name_matches === false && (
        <span className="px-1.5 rounded bg-rose-600 text-white text-[11px] font-semibold" data-testid={`${tid}-name-warning`}
          title={`Name on marksheet: ${s.sheet_name}`}>Name ≠ app: {s.sheet_name}</span>)}
      <span className="ml-auto flex gap-1">
        {s.has_file && <button type="button" onClick={onView} title="Open the scan" data-testid={`${tid}-view`} className={`${iconBtn} text-slate-600 hover:bg-slate-200`}><Eye size={13} /></button>}
        <button type="button" onClick={onEdit} title="Edit this marksheet" data-testid={`${tid}-edit`} className={`${iconBtn} text-slate-600 hover:bg-slate-200`}><Pencil size={13} /></button>
        <button type="button" onClick={onDelete} title="Delete this marksheet" data-testid={`${tid}-delete`} className={`${iconBtn} text-rose-600 hover:bg-rose-50`}><Trash2 size={13} /></button>
      </span>
    </li>
  );
}

export function MemberNode({ m, open, onToggle, onAdd, onEditMember, sheetActions }) {
  const bad = m.marksheets.some((s) => s.name_matches === false);
  const tid = `edu-member-${m.id}`;
  return (
    <li className="relative pl-5 before:absolute before:left-0 before:top-4 before:w-4 before:border-t before:border-slate-300" data-testid={tid}>
      <div className="flex flex-wrap items-center gap-2 py-1">
        <button type="button" onClick={onToggle} className="flex items-center gap-1.5 text-left font-semibold hover:text-sky-700" data-testid={`${tid}-toggle`}
          title={open ? "Hide marksheets" : "Show marksheets"}>
          <Chevron open={open} />{m.full_name}
        </button>
        <span className="text-[11px] capitalize text-slate-500">{m.category}</span>
        <span className="text-[11px] px-1.5 rounded-full bg-slate-100 text-slate-600" data-testid={`${tid}-count`}>{m.marksheets.length}</span>
        {bad && <span className="w-2 h-2 rounded-full bg-rose-600" title="A marksheet name doesn't match the app name" />}
        <span className="ml-auto flex gap-1">
          <button type="button" onClick={onAdd} title="Scan / upload a marksheet" data-testid={`${tid}-add`} className={`${iconBtn} bg-sky-600 text-white hover:bg-sky-700`}><Plus size={13} /> Marksheet</button>
          <button type="button" onClick={onEditMember} title="Open the member form" data-testid={`${tid}-edit-member`} className={`${iconBtn} border border-slate-300 text-slate-700 hover:bg-slate-100`}><UserCog size={13} /> Edit member</button>
        </span>
      </div>
      {open && (
        <ul className="ml-2 pl-4 border-l border-dashed border-slate-300" data-testid={`${tid}-sheets`}>
          {m.marksheets.map((s) => <SheetRow key={s.id} s={s} onView={() => sheetActions.view(s)} onEdit={() => sheetActions.edit(m, s)} onDelete={() => sheetActions.remove(s)} />)}
          {!m.marksheets.length && <li className="py-1.5 pl-3 text-xs text-slate-400">No marksheets yet</li>}
        </ul>
      )}
    </li>
  );
}

export function RootNode({ label, icon: Icon, count, open, onToggle, tid, children }) {
  return (
    <li data-testid={tid}>
      <button type="button" onClick={onToggle} className="flex items-center gap-2 py-2 text-base font-extrabold hover:text-sky-700" data-testid={`${tid}-toggle`}>
        <Chevron open={open} /><Icon size={16} className="text-sky-600" />{label}
        <span className="text-xs font-semibold px-2 rounded-full bg-sky-100 text-sky-800">{count}</span>
      </button>
      {open && <ul className="ml-2 border-l border-slate-300">{children}</ul>}
    </li>
  );
}
