import React, { useEffect, useMemo, useState } from "react";
import { Loader2, MessageSquare, Phone, RefreshCw, Filter } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

/**
 * SMS / Voice audit log — every Twilio dispatch the system has made.
 *
 * Pulls from the backend `sms_log` collection (most recent 200). Admins can
 * filter by channel (SMS / voice / both) and search free-text (member name,
 * destination number, body). Useful for "did we actually send the message?"
 * debugging and post-mortem on missed dispatches.
 */
const STATUS_TINT = {
  delivered:  "bg-emerald-100 text-emerald-800",
  sent:       "bg-emerald-100 text-emerald-800",
  queued:     "bg-sky-100 text-sky-800",
  accepted:   "bg-sky-100 text-sky-800",
  sending:    "bg-sky-100 text-sky-800",
  failed:     "bg-red-100 text-red-700",
  undelivered:"bg-red-100 text-red-700",
  busy:       "bg-amber-100 text-amber-800",
  "no-answer":"bg-amber-100 text-amber-800",
  canceled:   "bg-slate-200 text-slate-700",
  completed:  "bg-emerald-100 text-emerald-800",
  ringing:    "bg-sky-100 text-sky-800",
  initiated:  "bg-sky-100 text-sky-800",
  "in-progress": "bg-sky-100 text-sky-800",
};

export default function SmsLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [channel, setChannel] = useState("all"); // all | sms | voice
  const [q, setQ] = useState("");

  const load = async () => {
    setLoading(true);
    try { setRows(await api.get("/sms/log", { limit: 200 })); }
    catch (err) { toast.error(err?.message || "Failed to load SMS log"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    let list = rows;
    if (channel !== "all") list = list.filter((r) => r.kind === channel);
    const term = q.trim().toLowerCase();
    if (term) {
      list = list.filter((r) =>
        (r.to || "").toLowerCase().includes(term)
        || (r.body || "").toLowerCase().includes(term)
        || (r.institution || "").toLowerCase().includes(term)
        || (r.twilio_sid || "").toLowerCase().includes(term)
      );
    }
    return list;
  }, [rows, channel, q]);

  const counts = useMemo(() => ({
    all: rows.length,
    sms: rows.filter((r) => r.kind === "sms").length,
    voice: rows.filter((r) => r.kind === "voice").length,
  }), [rows]);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="sms-log-page">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">SMS &amp; Voice Log</h1>
          <p className="text-slate-500 text-sm mt-1">Every Twilio dispatch — full body, sender, recipient, delivery status.</p>
        </div>
        <button onClick={load} className="iu-btn-secondary"><RefreshCw size={14}/> Reload</button>
      </header>

      {/* Filters */}
      <div className="iu-card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <Filter size={14} className="text-slate-400 ml-1" />
        {[
          { key: "all", label: "All", n: counts.all },
          { key: "sms", label: "SMS", n: counts.sms },
          { key: "voice", label: "Voice", n: counts.voice },
        ].map((c) => (
          <button
            key={c.key}
            data-testid={`smslog-filter-${c.key}`}
            onClick={() => setChannel(c.key)}
            className={`inline-flex items-center gap-1.5 px-3 h-8 rounded-full text-xs font-semibold border transition ${
              channel === c.key
                ? "bg-slate-900 text-white border-transparent"
                : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
            }`}
          >
            {c.label}
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${
              channel === c.key ? "bg-white/20" : "bg-white border border-slate-200"
            }`}>{c.n}</span>
          </button>
        ))}
        <input
          data-testid="smslog-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search number, body, institution, twilio sid…"
          className="flex-1 min-w-[220px] ml-2 px-3 h-9 rounded-lg border border-slate-200 outline-none focus:border-sky-400 focus:ring-1 focus:ring-sky-200 text-sm"
        />
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500 text-sm">
          {rows.length === 0
            ? "No Twilio dispatches yet. Once you send your first test SMS or notify a parent, entries will appear here."
            : "No entries match the current filter."}
        </div>
      ) : (
        <div className="space-y-2" data-testid="smslog-list">
          {filtered.map((r) => (
            <div key={`${r.twilio_sid || r.at}-${r.to}`} className="iu-card p-4 flex gap-3" data-testid={`smslog-row-${r.twilio_sid}`}>
              {/* Channel icon */}
              <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
                r.kind === "voice" ? "bg-emerald-100 text-emerald-700" : "bg-sky-100 text-sky-700"
              }`}>
                {r.kind === "voice" ? <Phone size={16} /> : <MessageSquare size={16} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="font-bold text-sm uppercase tracking-wide text-slate-700">{r.kind}</span>
                  <span className="font-mono text-xs text-slate-700">{r.to}</span>
                  {r.from && <span className="font-mono text-[11px] text-slate-400">from {r.from}</span>}
                  <span className={`px-2 h-5 rounded-full text-[10px] font-bold flex items-center ${STATUS_TINT[r.status] || "bg-slate-100 text-slate-700"}`}>{r.status || "—"}</span>
                  {r.institution && <span className="px-2 h-5 rounded-full text-[10px] bg-violet-50 text-violet-700 border border-violet-200 flex items-center">{r.institution}</span>}
                  <span className="ml-auto text-[11px] text-slate-400 font-mono">{r.at?.slice(0, 19).replace("T", " ")}</span>
                </div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap break-words">{r.body || "—"}</div>
                {r.twilio_sid && <div className="mt-1 text-[11px] text-slate-400 font-mono">sid: {r.twilio_sid}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
