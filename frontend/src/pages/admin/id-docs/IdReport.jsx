import React, { useEffect, useMemo, useState } from "react";
import { Check, X, Download, Loader2, Search } from "lucide-react";
import { api, showApiError } from "../../../api";
import MemberForm from "../MemberForm";

const PERSON_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const MISSING = {
  any: { label: "Missing anything", test: (r) => !r.pan || !r.aadhaar || !r.pan_scan || !r.aadhaar_scan },
  pan: { label: "Missing PAN", test: (r) => !r.pan || !r.pan_scan },
  aadhaar: { label: "Missing Aadhaar", test: (r) => !r.aadhaar || !r.aadhaar_scan },
  scans: { label: "Missing scans only", test: (r) => !r.pan_scan || !r.aadhaar_scan },
  all: { label: "Show everyone", test: () => true },
};
const COLS = ["member_name", "person", "person_name", "category", "pan", "pan_scan", "aadhaar", "aadhaar_scan"];

const Cell = ({ ok, text, tid }) => (ok
  ? <span className="inline-flex items-center gap-1 text-emerald-700 font-mono text-xs" data-testid={tid} title="On file"><Check size={13} />{text || ""}</span>
  : <span className="inline-flex items-center gap-1 text-rose-600 text-xs font-semibold" data-testid={tid} title="Missing — chase this"><X size={13} />Missing</span>);

function downloadCsv(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const body = [COLS.join(","), ...rows.map((r) => COLS.map((c) => esc(typeof r[c] === "boolean" ? (r[c] ? "yes" : "MISSING") : r[c])).join(","))];
  const url = URL.createObjectURL(new Blob([body.join("\n")], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "missing-id-documents.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

const Select = ({ value, onChange, options, tid, title }) => (
  <select value={value} onChange={(e) => onChange(e.target.value)} className="iu-input !w-auto" data-testid={tid} title={title}>
    {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
  </select>
);

export default function IdReport() {
  const [rows, setRows] = useState(null);
  const [missing, setMissing] = useState("any");
  const [person, setPerson] = useState("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);

  const load = () => api.get("/id-docs/report").then((r) => setRows(r.rows)).catch((e) => showApiError(e, "Couldn't load report"));
  useEffect(() => { load(); }, []);

  const categories = useMemo(() => [...new Set((rows || []).map((r) => r.category).filter(Boolean))].sort(), [rows]);
  const shown = useMemo(() => (rows || []).filter((r) => MISSING[missing].test(r)
    && (person === "all" || r.person === person) && (category === "all" || r.category === category)
    && (!q || `${r.member_name} ${r.person_name}`.toLowerCase().includes(q.toLowerCase()))), [rows, missing, person, category, q]);

  const open = async (id) => {
    try { setEditing(await api.get(`/members/${id}`)); } catch (e) { showApiError(e, "Couldn't open member"); }
  };

  if (!rows) return <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>;
  return (
    <div data-testid="id-report">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" className="iu-input !pl-8 !w-56"
            data-testid="id-report-search" title="Filter by member or parent name" />
        </div>
        <Select value={missing} onChange={setMissing} tid="id-report-missing" title="Which gaps to show"
          options={Object.entries(MISSING).map(([k, v]) => [k, v.label])} />
        <Select value={person} onChange={setPerson} tid="id-report-person" title="Member themselves or a parent/guardian"
          options={[["all", "All people"], ...Object.entries(PERSON_LABEL)]} />
        <Select value={category} onChange={setCategory} tid="id-report-category" title="Member category"
          options={[["all", "All categories"], ...categories.map((c) => [c, c])]} />
        <span className="text-xs text-slate-500" data-testid="id-report-count">{shown.length} rows</span>
        <button type="button" onClick={() => downloadCsv(shown)} className="iu-btn-secondary ml-auto" data-testid="id-report-csv"
          title="Download the rows shown as a CSV to share with the office">
          <Download size={15} /> CSV
        </button>
      </div>
      <div className="iu-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left p-2" title="Academy member">Member</th>
              <th className="text-left p-2" title="Member themselves, or their father / mother / guardian">Person</th>
              <th className="text-left p-2" title="Member category">Category</th>
              <th className="text-left p-2" title="PAN number on file">PAN no.</th>
              <th className="text-left p-2" title="PAN scan uploaded">PAN scan</th>
              <th className="text-left p-2" title="Aadhaar number on file">Aadhaar no.</th>
              <th className="text-left p-2" title="Aadhaar scan uploaded">Aadhaar scan</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const tid = `id-row-${r.member_id}-${r.person}`;
              return (
                <tr key={tid} data-testid={tid} onClick={() => open(r.member_id)} title="Click to open this member and add the missing details"
                  className="border-t border-slate-100 hover:bg-amber-50/60 cursor-pointer">
                  <td className="p-2 font-semibold">{r.member_name}</td>
                  <td className="p-2">{PERSON_LABEL[r.person]}{r.person !== "self" && <span className="text-slate-500"> · {r.person_name || "name not set"}</span>}</td>
                  <td className="p-2 text-xs text-slate-600">{r.category}</td>
                  <td className="p-2"><Cell ok={!!r.pan} text={r.pan} tid={`${tid}-pan`} /></td>
                  <td className="p-2"><Cell ok={r.pan_scan} tid={`${tid}-pan-scan`} /></td>
                  <td className="p-2"><Cell ok={!!r.aadhaar} text={r.aadhaar} tid={`${tid}-aadhaar`} /></td>
                  <td className="p-2"><Cell ok={r.aadhaar_scan} tid={`${tid}-aadhaar-scan`} /></td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="p-8 text-center text-slate-400" data-testid="id-report-empty">Nothing missing for this filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <MemberForm initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
