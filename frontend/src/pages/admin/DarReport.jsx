import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileText, Download, Loader2, Search, AlertTriangle, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob, showApiError } from "../../api";
import { Highlight, fmtDate, fmtHM } from "../../components/DarHistorySection";
import { DarShareButton } from "../../components/Dar";

const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const monthOf = (iso) => iso.slice(0, 7);
const firstOfMonth = (iso) => `${monthOf(iso)}-01`;
const CATS = [["", "All"], ["staff", "Staff"], ["coach", "Coaches"], ["executive", "Executives"], ["elite", "Elite athletes"]];

export default function DarReport() {
  const [params] = useSearchParams();
  const highlightMember = params.get("member") || "";
  const [tab, setTab] = useState(params.get("tab") === "missed" ? "missed" : "reports");
  const [from, setFrom] = useState(firstOfMonth(todayISO()));
  const [to, setTo] = useState(todayISO());
  const [category, setCategory] = useState("");
  const [memberId, setMemberId] = useState(highlightMember);
  const [q, setQ] = useState("");
  const [members, setMembers] = useState([]);
  const [rows, setRows] = useState(null);
  const [missed, setMissed] = useState(null);
  const [month, setMonth] = useState(params.get("month") || monthOf(todayISO()));
  const [groupName, setGroupName] = useState("");
  const [loading, setLoading] = useState(false);
  const highlightRef = useRef(null);

  useEffect(() => {
    api.get("/members").then((m) => setMembers((m || []).filter((u) => ["staff", "coach", "executive"].includes(u.category) || u.dar_required)
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")))).catch(() => {});
    api.get("/config/dar-policy").then((p) => setGroupName(p?.group_name || "")).catch(() => {});
  }, []);

  useEffect(() => {
    if (tab !== "reports") return;
    setLoading(true);
    const t = setTimeout(() => {
      api.get("/admin/dar", { from_: from, to, category: category || undefined, member_id: memberId || undefined, q })
        .then((r) => setRows(r.rows || []))
        .catch((e) => showApiError(e, "Couldn't load DARs"))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [tab, from, to, category, memberId, q]);

  useEffect(() => {
    if (tab !== "missed") return;
    setLoading(true);
    api.get("/admin/dar/missed", { month })
      .then(setMissed)
      .catch((e) => showApiError(e, "Couldn't load missed DARs"))
      .finally(() => setLoading(false));
  }, [tab, month]);

  // When arriving from the Grid's DAR ✗ column, scroll the flagged
  // member's row into view once the missed table has rendered.
  useEffect(() => {
    if (tab === "missed" && highlightMember && missed && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [tab, highlightMember, missed]);

  const memberById = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m])), [members]);

  const exportCsv = async () => {
    try {
      await downloadBlob("/admin/dar/export", `dar_${from}_${to}.csv`,
        { from_: from, to, category: category || undefined, member_id: memberId || undefined, q });
      toast.success("CSV downloaded");
    } catch (e) { showApiError(e, "Export failed"); }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6" data-testid="dar-report-page">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <FileText size={22} className="text-sky-600" /> Daily Activity Reports
          </h1>
          <p className="text-slate-500 text-sm mt-1">Every DAR filed at check-out, searchable by keyword. Missed DARs feed payroll deductions.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab("reports")} data-testid="dar-tab-reports"
                  title="Browse and search all filed Daily Activity Reports"
                  className={`px-4 h-9 rounded-full text-sm font-semibold ${tab === "reports" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>
            Reports
          </button>
          <button onClick={() => setTab("missed")} data-testid="dar-tab-missed"
                  title="See DAR-required members who worked but did not file a DAR (for payroll)"
                  className={`px-4 h-9 rounded-full text-sm font-semibold inline-flex items-center gap-1 ${tab === "missed" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>
            <AlertTriangle size={13} /> Missed
          </button>
        </div>
      </header>

      {tab === "reports" && (
        <>
          <div className="iu-card p-3 md:p-4 mb-4 flex flex-wrap items-center gap-2" data-testid="dar-filters">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="dar-from" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="dar-to" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="dar-category">
              {CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className="iu-input !h-9 !w-auto text-sm max-w-[220px]" data-testid="dar-member">
              <option value="">All members</option>
              {members.filter((m) => !category || m.category === category).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
            </select>
            <label className="relative flex-1 min-w-[200px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search keywords in DARs…" className="iu-input !h-9 !pl-8 text-sm w-full" data-testid="dar-search" />
            </label>
            <button onClick={exportCsv} className="iu-btn-secondary !h-9" data-testid="dar-export-csv" title="Download the filtered DARs as a spreadsheet">
              <Download size={15} /> CSV
            </button>
          </div>
          <p className="text-xs text-slate-500 mb-2" data-testid="dar-count">{rows ? `${rows.length} DAR${rows.length === 1 ? "" : "s"}` : ""}</p>
          {loading && rows === null ? (
            <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : rows && rows.length === 0 ? (
            <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="dar-empty">No DARs in this range.</div>
          ) : (
            <ul className="space-y-3" data-testid="dar-list">
              {(rows || []).map((r) => (
                <li key={r.id} className="iu-card p-4" data-testid={`dar-item-${r.id}`}>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <Link to={`/profile?member=${r.user_id}`} className="font-bold text-slate-900 hover:underline">{r.user_name}</Link>
                    <span className="uppercase text-[10px] font-semibold text-slate-400">{r.category}{r.rank ? ` · ${r.rank}` : ""}</span>
                    <span>·</span>
                    <span className="font-semibold text-slate-700">{fmtDate(r.date)}</span>
                    <span>{fmtHM(r.check_in_at)} – {fmtHM(r.check_out_at)}</span>
                    {r.filed_late && <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold">filed late</span>}
                    <DarShareButton dar={r} name={r.user_name} groupName={groupName} className="ml-auto !h-7 !px-3 !text-xs" />
                  </div>
                  <p className="text-sm text-slate-800 mt-2 whitespace-pre-wrap leading-relaxed"><Highlight text={r.text} q={q} /></p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {tab === "missed" && (
        <>
          <div className="iu-card p-3 md:p-4 mb-4 flex flex-wrap items-center gap-3">
            <input type="month" value={month} max={monthOf(todayISO())} onChange={(e) => setMonth(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="dar-missed-month" />
            <span className="text-xs text-slate-500">
              A miss = a worked day (checked in) with no DAR, from the policy effective date, excluding today. Payroll deducts one day per miss.
            </span>
            {missed && <span className="ml-auto text-sm font-bold text-rose-700" data-testid="dar-missed-total">{missed.total_missed} missed</span>}
          </div>
          {loading ? (
            <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : !missed ? null : (
            <div className="iu-card overflow-hidden">
              <table className="w-full text-sm" data-testid="dar-missed-table">
                <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                  <tr><th className="text-left p-2">Member</th><th className="text-left p-2">Category</th><th className="text-right p-2">Missed</th><th className="text-left p-2">Dates</th></tr>
                </thead>
                <tbody>
                  {missed.rows.map((r, idx) => {
                    const isHi = r.member_id === highlightMember;
                    const zebra = idx % 2 === 1 ? "bg-slate-200" : "bg-white";
                    return (
                    <tr key={r.member_id} ref={isHi ? highlightRef : null}
                        className={`border-t border-slate-100 ${isHi ? "bg-sky-100 ring-2 ring-inset ring-sky-400" : `${zebra} hover:bg-sky-50`}`}
                        data-testid={`dar-missed-row-${r.member_id}`}>
                      <td className="p-2 font-semibold"><Link to={`/profile?member=${r.member_id}`} className="hover:underline">{r.member_name}</Link></td>
                      <td className="p-2 text-slate-500 uppercase text-[11px]">{r.category}</td>
                      <td className={`p-2 text-right tabular-nums font-bold ${r.missed > 0 ? "text-rose-600" : "text-emerald-700"}`}>{r.missed}</td>
                      <td className="p-2 text-xs text-slate-600">{r.missed_dates.map((d) => d.slice(8)).join(", ")}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              {missed.exempt?.length > 0 && (
                <div className="p-3 text-xs text-slate-500 border-t border-slate-100 flex items-center gap-1.5" data-testid="dar-exempt-list">
                  <ClipboardList size={12} /> DAR-exempt: {missed.exempt.map((e) => e.member_name).join(", ")}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {memberId && memberById[memberId] && tab === "reports" && (
        <p className="text-[11px] text-slate-400 mt-4">Showing DARs for {memberById[memberId].full_name}.</p>
      )}
    </div>
  );
}
