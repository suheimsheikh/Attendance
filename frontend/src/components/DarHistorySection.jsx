import React, { useEffect, useMemo, useState } from "react";
import { Loader2, FileText, Search } from "lucide-react";
import { api } from "../api";
import { DarShareButton } from "./Dar";

export function Highlight({ text, q }) {
  if (!q?.trim()) return <>{text}</>;
  const parts = String(text || "").split(new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return <>{parts.map((p, i) => p.toLowerCase() === q.trim().toLowerCase()
    ? <mark key={i} className="bg-amber-200 rounded px-0.5">{p}</mark> : p)}</>;
}

export const fmtDate = (iso) => iso
  ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "2-digit" })
  : "";
export const fmtHM = (iso) => iso
  ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
  : "—";

/** Profile section: a member's DAR history with keyword search. */
export default function DarHistorySection({ memberId, memberName }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [groupName, setGroupName] = useState("");

  useEffect(() => {
    let ignore = false;
    const req = memberId ? api.get("/admin/dar", { member_id: memberId, limit: 500 }) : api.get("/dar/mine");
    Promise.all([req, api.get("/config/dar-policy").catch(() => null)])
      .then(([r, p]) => { if (!ignore) { setRows(r?.rows || []); setGroupName(p?.group_name || ""); } })
      .catch(() => !ignore && setRows([]));
    return () => { ignore = true; };
  }, [memberId]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (rows || []).filter((r) => !s || (r.text || "").toLowerCase().includes(s) || (r.date || "").includes(s));
  }, [rows, q]);

  if (rows && rows.length === 0 && !q) return null;

  return (
    <section className="iu-card p-5 mt-6" data-testid="dar-history-section">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <h3 className="font-extrabold tracking-tight text-sm text-slate-500 uppercase flex items-center gap-2">
          <FileText size={14} /> {memberId ? "Daily Activity Reports" : "My DARs"}
        </h3>
        <label className="ml-auto relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search keywords…"
                 className="iu-input !h-9 !pl-8 text-sm w-56" data-testid="dar-history-search" />
        </label>
      </div>
      {rows === null ? (
        <div className="text-center py-6"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-slate-400 italic" data-testid="dar-history-empty">No DARs match.</p>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="dar-history-list">
          {filtered.map((r) => (
            <li key={r.id} className="py-3" data-testid={`dar-row-${r.date}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-bold text-slate-800">{fmtDate(r.date)}</span>
                <span>{fmtHM(r.check_in_at)} – {fmtHM(r.check_out_at)}</span>
                {r.filed_late && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">filed late</span>}
                <DarShareButton dar={r} name={memberName} groupName={groupName} className="ml-auto !h-7 !px-3 !text-xs" />
              </div>
              <p className="text-sm text-slate-700 mt-1 whitespace-pre-wrap"><Highlight text={r.text} q={q} /></p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
