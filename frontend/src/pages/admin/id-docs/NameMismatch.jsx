import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Search, RefreshCw, Check } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";
import MemberForm from "../MemberForm";

const PERSON_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const CARDS = [["passport", "Passport"], ["aadhaar", "Aadhaar"], ["pan", "PAN"], ["birth", "Birth cert"]];
const bad = (c) => c && c.match === false;
const FILTERS = {
  any: ["Any mismatch", (r) => CARDS.some(([k]) => bad(r[k]))],
  passport: ["App ≠ passport", (r) => bad(r.passport)],
  aadhaar: ["Aadhaar mismatch", (r) => bad(r.aadhaar)],
  pan: ["PAN mismatch", (r) => bad(r.pan)],
  birth: ["Birth certificate mismatch", (r) => bad(r.birth)],
  nopassport: ["No passport name yet", (r) => !r.passport?.name],
  all: ["Show everyone", () => true],
};

function NameCell({ c, tid }) {
  if (c === null) return <span className="text-slate-300 text-xs">n/a</span>;
  if (!c.name) return <span className="text-slate-400 text-xs" data-testid={tid}>{c.unread ? "scan not read" : "—"}</span>;
  return c.match
    ? <span className="inline-flex items-center gap-1 text-emerald-700 text-xs" data-testid={tid} title="Exactly the app name"><Check size={12} />{c.name}</span>
    : <span className="px-1.5 py-0.5 rounded bg-rose-600 text-white text-xs font-semibold" data-testid={tid} title="Not exactly the app name">{c.name}</span>;
}

// Old scans have no saved card name — read them in small batches, once.
function RereadButton({ pending, onDone }) {
  const [busy, setBusy] = useState(null);
  const run = async () => {
    setBusy({ done: 0, total: pending });
    try {
      let remaining = pending, done = 0;
      while (remaining > 0) {
        const r = await api.post("/id-docs/reread-names?limit=6");
        done += r.done;
        remaining = r.remaining;
        setBusy({ done, total: done + remaining });
        if (!r.done) break;
      }
      toast.success("Old scans read");
    } catch (e) { showApiError(e, "Re-read stopped — press again to continue"); }
    setBusy(null);
    onDone();
  };
  if (!pending && !busy) return null;
  return (
    <button type="button" onClick={run} disabled={!!busy} className="iu-btn-secondary" data-testid="name-report-reread"
      title="Read the name on scans uploaded before names were saved (uses a little AI credit per scan)">
      {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
      {busy ? `Reading ${busy.done}/${busy.total}…` : `Re-read old scans (${pending})`}
    </button>
  );
}

export default function NameMismatch() {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("any");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const load = () => api.get("/id-docs/name-report").then(setData).catch((e) => showApiError(e, "Couldn't load name report"));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => (data?.rows || []).filter((r) => FILTERS[filter][1](r)
    && (!q || `${r.member_name} ${r.person_name}`.toLowerCase().includes(q.toLowerCase()))), [data, filter, q]);
  const open = async (id) => {
    try { setEditing(await api.get(`/members/${id}`)); } catch (e) { showApiError(e, "Couldn't open member"); }
  };

  if (!data) return <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>;
  return (
    <div data-testid="name-report">
      <p className="text-xs text-rose-800 bg-rose-50 border border-rose-200 rounded px-2 py-1.5 mb-3">
        The app name must be <b>exactly</b> the passport name (same words, same order). Red = not exactly the app name.
        Aadhaar, PAN and birth certificate names can&apos;t be changed here — fix the app name from the passport.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" className="iu-input !pl-8 !w-56"
            data-testid="name-report-search" title="Filter by member or parent name" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="iu-input !w-auto" data-testid="name-report-filter" title="Which mismatches to show">
          {Object.entries(FILTERS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <span className="text-xs text-slate-500" data-testid="name-report-count">{shown.length} rows</span>
        <div className="ml-auto"><RereadButton pending={data.pending_rereads} onDone={load} /></div>
      </div>
      <div className="iu-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="p-2 text-left">Member</th><th className="p-2 text-left">Person</th>
              <th className="p-2 text-left" title="Name saved in the app">App name</th>
              {CARDS.map(([k, l]) => <th key={k} className="p-2 text-left" title={`Name read from the ${l} scan`}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const tid = `name-row-${r.member_id}-${r.person}`;
              return (
                <tr key={tid} data-testid={tid} onClick={() => open(r.member_id)} title="Click to open this member"
                  className="border-t border-slate-100 hover:bg-amber-50/60 cursor-pointer">
                  <td className="p-2 font-semibold">{r.member_name}</td>
                  <td className="p-2 text-xs">{PERSON_LABEL[r.person]}</td>
                  <td className="p-2 text-xs font-semibold" data-testid={`${tid}-app`}>{r.person_name || <span className="text-slate-400">not set</span>}</td>
                  {CARDS.map(([k]) => <td key={k} className="p-2"><NameCell c={r[k]} tid={`${tid}-${k}`} /></td>)}
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="p-8 text-center text-slate-400" data-testid="name-report-empty">No name mismatches for this filter.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <MemberForm initial={editing} onClose={() => { setEditing(null); load(); }} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}
