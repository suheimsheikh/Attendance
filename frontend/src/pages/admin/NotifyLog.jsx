import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Filter, Send, UserX, Clock } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

/**
 * Parent Notify Log — dated proof-of-contact record. Every time a coach or
 * admin taps a "Notify parent" WhatsApp button on the Muster page, a row is
 * written here: which athlete, which parent (role + number), the reason
 * (absent / late), who sent it, and when. WhatsApp gives no delivery
 * receipt, so this proves contact was *initiated*, not read.
 */
const REASON_TINT = {
  absent: "bg-amber-100 text-amber-800",
  late: "bg-orange-100 text-orange-800",
};

const ROLE_LABEL = { father: "Father", mother: "Mother", guardian: "Guardian" };

export default function NotifyLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("all"); // all | absent | late
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setRows(await api.get("/notify/log", { limit: 500 })); }
    catch (err) { toast.error(err?.message || "Failed to load notify log"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    let list = rows;
    if (reason !== "all") list = list.filter((r) => r.reason === reason);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((r) =>
        (r.member_name || "").toLowerCase().includes(term)
        || (r.parent_number || "").toLowerCase().includes(term)
        || (r.sent_by || "").toLowerCase().includes(term)
        || (r.date || "").toLowerCase().includes(term)
      );
    }
    return list;
  }, [rows, reason, q]);

  const counts = useMemo(() => ({
    all: rows.length,
    absent: rows.filter((r) => r.reason === "absent").length,
    late: rows.filter((r) => r.reason === "late").length,
  }), [rows]);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="notify-log-page">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Parent Notify Log</h1>
          <p className="text-slate-500 text-sm mt-1">
            Proof of contact — every WhatsApp parent notification opened from Muster,
            with who sent it and when. (WhatsApp gives no delivery receipt, so this
            records that contact was <em>initiated</em>.)
          </p>
        </div>
        <button onClick={load} className="iu-btn-secondary" data-testid="notifylog-reload"><RefreshCw size={14}/> Reload</button>
      </header>

      <div className="iu-card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <Filter size={14} className="text-slate-400 ml-1" />
        {[
          { key: "all", label: "All", n: counts.all },
          { key: "absent", label: "Absent", n: counts.absent },
          { key: "late", label: "Late", n: counts.late },
        ].map((c) => (
          <button
            key={c.key}
            data-testid={`notifylog-filter-${c.key}`}
            onClick={() => setReason(c.key)}
            className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-semibold border transition ${
              reason === c.key
                ? "bg-slate-900 text-white border-transparent"
                : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
            }`}
          >
            {c.label}
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${
              reason === c.key ? "bg-white/20" : "bg-white border border-slate-200"
            }`}>{c.n}</span>
          </button>
        ))}
        <input
          data-testid="notifylog-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search athlete, number, sent-by, date…"
          className="flex-1 min-w-[220px] ml-2 px-3 h-9 rounded-lg border border-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200 text-sm"
        />
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500 text-sm">
          {rows.length === 0
            ? "No parent notifications yet. Once someone taps a Notify Parent button on Muster, entries appear here."
            : "No entries match the current filter."}
        </div>
      ) : (
        <div className="space-y-2" data-testid="notifylog-list">
          {filtered.map((r) => (
            <div key={r.id} className="iu-card p-4 flex gap-3" data-testid={`notifylog-row-${r.id}`}>
              <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                r.reason === "late" ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700"
              }`}>
                {r.reason === "late" ? <Clock size={16} /> : <UserX size={16} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-bold text-sm text-slate-800 truncate">{r.member_name}</span>
                  <span className={`px-2 h-5 rounded-full text-[10px] font-bold flex items-center ${REASON_TINT[r.reason] || "bg-slate-100 text-slate-700"}`}>
                    {r.reason}
                  </span>
                  <span className="px-2 h-5 rounded-full text-[10px] bg-sky-50 text-sky-700 border border-sky-200 flex items-center">
                    {ROLE_LABEL[r.parent_role] || r.parent_role}
                  </span>
                  <span className="font-mono text-xs text-slate-700 flex items-center gap-1"><Send size={11} className="text-[#25D366]" />{r.parent_number}</span>
                  <span className="ml-auto text-[11px] text-slate-400 font-mono">{(r.created_at || "").slice(0, 19).replace("T", " ")}</span>
                </div>
                <div className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-600">{r.date}</span>
                  {" · sent by "}
                  <span className="font-semibold text-slate-700">{r.sent_by || "—"}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
