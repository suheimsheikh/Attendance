import React, { useCallback, useEffect, useState } from "react";
import { Plane, Send, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { shareToWhatsApp } from "../utils/shareWhatsApp";

const PERSON = { self: "", father: " (father)", mother: " (mother)", guardian: " (guardian)" };
const HIDE_KEY = "passport-week-later";

// Monday (and until posted that week): the first admin is asked to post the
// expiring-passports list to WhatsApp; once posted, other admins aren't asked.
export function PassportExpiryPrompt() {
  const [st, setSt] = useState(null);
  const check = useCallback(async () => {
    try {
      const s = await api.get("/id-docs/passport-expiry-week");
      setSt(s.due && sessionStorage.getItem(HIDE_KEY) !== s.week ? s : null);
    } catch { setSt(null); }
  }, []);
  useEffect(() => { check(); window.addEventListener("focus", check); return () => window.removeEventListener("focus", check); }, [check]);
  if (!st) return null;

  const text = ["🛂 *Passports expired / expiring within 6 months*", "",
    ...st.rows.map((r) => `• ${r.person === "self" ? r.member_name : `${r.person_name || "—"}${PERSON[r.person]} of ${r.member_name}`} — ${r.passport_expiry}${r.status === "expired" ? " (EXPIRED)" : ""}`)].join("\n");
  const send = () => {
    shareToWhatsApp({ text });
    setSt(null);
    api.post("/id-docs/passport-expiry-week").then((res) => {
      if (!res.first) toast.info(`Already posted this week by ${res.sent_by_name}`);
    }).catch(() => {});
  };
  const later = () => { sessionStorage.setItem(HIDE_KEY, st.week); setSt(null); };

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-[360px] max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl border border-slate-200 p-4" data-testid="passport-week-prompt">
      <div className="flex items-start justify-between gap-2">
        <div className="font-bold flex items-center gap-2"><Plane size={16} className="text-sky-600" /> Passports expiring</div>
        <button type="button" onClick={later} className="p-1 text-slate-400 hover:text-slate-800" title="Hide for now" data-testid="passport-week-close"><X size={15} /></button>
      </div>
      <p className="text-xs text-slate-500 mt-1">{st.rows.length} passport{st.rows.length === 1 ? "" : "s"} expired or expiring within 6 months. Post this week&apos;s list to the admins&apos; WhatsApp group.</p>
      <ul className="text-xs mt-2 max-h-40 overflow-y-auto space-y-0.5" data-testid="passport-week-list">
        {st.rows.map((r) => (
          <li key={`${r.member_id}-${r.person}`} className={r.status === "expired" ? "text-rose-700" : "text-amber-800"}>
            {r.person === "self" ? r.member_name : `${r.person_name || "—"}${PERSON[r.person]} · ${r.member_name}`} — {r.passport_expiry}
          </li>
        ))}
      </ul>
      <div className="flex gap-2 mt-3">
        <button type="button" onClick={send} className="iu-btn-primary flex-1" data-testid="passport-week-send" title="Opens WhatsApp with the list ready to post">
          <Send size={14} /> Send to WhatsApp
        </button>
        <button type="button" onClick={later} className="iu-btn-secondary" data-testid="passport-week-later" title="Remind me later">Later</button>
      </div>
    </div>
  );
}
