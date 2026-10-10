import React, { useEffect, useMemo, useState } from "react";
import { GraduationCap, Loader2, Search, Users, Dumbbell } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import MemberForm from "./MemberForm";
import MarksheetModal from "./education/MarksheetModal";
import { MemberNode, RootNode } from "./education/TreeNodes";

const ROOTS = [["athletes", "Athletes", Users], ["coaches", "Coaches", Dumbbell]];

export default function Education() {
  const [tree, setTree] = useState(null);
  const [q, setQ] = useState("");
  const [openRoots, setOpenRoots] = useState({ athletes: true, coaches: true });
  const [openMembers, setOpenMembers] = useState({});
  const [modal, setModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => api.get("/education/tree").then(setTree).catch((e) => showApiError(e, "Couldn't load education"));
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!tree) return null;
    const t = q.trim().toLowerCase();
    return Object.fromEntries(ROOTS.map(([k]) => [k, tree[k].filter((m) => !t || (m.full_name || "").toLowerCase().includes(t)
      || m.marksheets.some((s) => s.exam_name.toLowerCase().includes(t)))]));
  }, [tree, q]);

  const toggleMember = (id) => setOpenMembers((x) => ({ ...x, [id]: !x[id] }));
  const expandAll = (v) => setOpenMembers(v ? Object.fromEntries(ROOTS.flatMap(([k]) => tree[k].map((m) => [m.id, true]))) : {});
  const sheetActions = {
    view: async (s) => {
      try { window.open(URL.createObjectURL(await api.getBlob(`/education/marksheets/${s.id}/file`)), "_blank"); }
      catch (e) { showApiError(e, "Couldn't open the scan"); }
    },
    edit: (m, s) => setModal({ member: m, sheet: s }),
    remove: async (s) => {
      if (!window.confirm(`Delete "${s.exam_name}"? This can't be undone.`)) return;
      try { await api.del(`/education/marksheets/${s.id}`); toast.success("Marksheet deleted"); load(); }
      catch (e) { showApiError(e, "Couldn't delete"); }
    },
  };
  const openMember = async (id) => {
    try { setEditing(await api.get(`/members/${id}`)); } catch (e) { showApiError(e, "Couldn't open member"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl" data-testid="education-page">
      <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2"><GraduationCap className="text-sky-600" /> Education</h1>
      <p className="text-slate-500 text-sm mt-1 mb-5">Marksheets for active athletes &amp; coaches — names A→Z, newest exam first.</p>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or exam…" className="iu-input !pl-8 !w-64" data-testid="education-search" />
        </div>
        <button type="button" onClick={() => expandAll(true)} className="iu-btn-secondary !py-1 text-xs" data-testid="education-expand-all" disabled={!tree}>Expand all</button>
        <button type="button" onClick={() => expandAll(false)} className="iu-btn-secondary !py-1 text-xs" data-testid="education-collapse-all">Collapse all</button>
      </div>
      {!filtered ? <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div> : (
        <ul className="iu-card p-4 space-y-1" data-testid="education-tree">
          {ROOTS.map(([k, label, icon]) => (
            <RootNode key={k} tid={`edu-root-${k}`} label={label} icon={icon} count={filtered[k].length}
              open={openRoots[k]} onToggle={() => setOpenRoots((x) => ({ ...x, [k]: !x[k] }))}>
              {filtered[k].map((m) => (
                <MemberNode key={m.id} m={m} open={!!openMembers[m.id]} onToggle={() => toggleMember(m.id)}
                  onAdd={() => setModal({ member: m })} onEditMember={() => openMember(m.id)} sheetActions={sheetActions} />
              ))}
              {!filtered[k].length && <li className="pl-5 py-2 text-xs text-slate-400">No matches</li>}
            </RootNode>
          ))}
        </ul>
      )}
      {modal && <MarksheetModal {...modal} onClose={() => setModal(null)}
        onSaved={() => { setOpenMembers((x) => ({ ...x, [modal.member.id]: true })); setModal(null); load(); }} />}
      {editing && <MemberForm initial={editing} onClose={() => { setEditing(null); load(); }} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
