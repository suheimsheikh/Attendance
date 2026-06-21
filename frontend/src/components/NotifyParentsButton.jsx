import React, { useState } from "react";
import { Send, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";

/**
 * Renders a single tap-to-send button for parent SMS notifications.
 * Opens the device's native SMS app with all parents' numbers and a
 * bilingual (English + Telugu) message body pre-filled, then records
 * the dispatch on the backend so the button hides for the rest of the day.
 *
 * Props:
 *   member          — presence row (must include id, full_name, father_mobile, mother_mobile, guardian_mobile, work_start)
 *   type            — "not_arrived" | "late"
 *   adminContacts   — [{full_name, mobile}] used in the "call us" line
 *   coachMobile     — current logged-in coach's mobile (added to the contact list)
 *   notified        — true if already sent today (renders a muted "Sent" pill)
 *   onSent          — callback after a successful dispatch (parent should refresh)
 */
export default function NotifyParentsButton({ member, type, adminContacts = [], coachMobile, notified = false, onSent }) {
  const [busy, setBusy] = useState(false);

  const parentNumbers = [member.father_mobile, member.mother_mobile, member.guardian_mobile]
    .map((n) => (n || "").trim())
    .filter(Boolean);

  if (parentNumbers.length === 0) return null;

  if (notified) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 h-6 rounded-full bg-slate-100 text-slate-500 text-[10px] font-bold border border-slate-200"
        data-testid={`parent-notify-sent-${type}-${member.id}`}
        title="Already notified today"
      >
        <Check size={10} /> SMS sent
      </span>
    );
  }

  const callbackNumbers = [
    ...adminContacts.map((a) => (a.mobile || "").trim()).filter(Boolean),
    (coachMobile || "").trim(),
  ].filter(Boolean);
  const callbackJoined = callbackNumbers.join(" / ");

  const nowHHMM = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const expectedBy = member.work_start || "the scheduled time";

  // Bilingual templates: English on top, Telugu underneath. Each sentence is
  // short so it fits within a single 70-char Unicode SMS segment where possible.
  let body;
  if (type === "not_arrived") {
    body =
      `YCH: ${member.full_name} has NOT checked in today by ${expectedBy}. Please confirm. ` +
      `For queries please call ${callbackJoined || "the academy"}.\n\n` +
      `వైసీహెచ్: ${member.full_name} ఈ రోజు ${expectedBy} వరకు హాజరు కాలేదు. దయచేసి నిర్ధారించండి. ` +
      `ప్రశ్నల కోసం ${callbackJoined || "అకాడమీ"}కి ఫోన్ చేయండి.`;
  } else {
    // late
    body =
      `YCH: ${member.full_name} checked in LATE at ${nowHHMM} today (expected by ${expectedBy}). ` +
      `For queries please call ${callbackJoined || "the academy"}.\n\n` +
      `వైసీహెచ్: ${member.full_name} ఈ రోజు ${nowHHMM}కి ఆలస్యంగా చేరారు (అంచనా ${expectedBy}). ` +
      `ప్రశ్నల కోసం ${callbackJoined || "అకాడమీ"}కి ఫోన్ చేయండి.`;
  }

  const handleClick = async (e) => {
    e.stopPropagation();
    setBusy(true);
    // Server sends the SMS via Twilio (no device composer — avoids double-send).
    try {
      const res = await api.post("/parent-notify/dispatch", { user_id: member.id, type, message: body });
      if (res.already_sent) {
        toast.success(`Parents already notified today`);
      } else {
        toast.success(`SMS sent to ${member.full_name}'s parents (${res.sms_sent})`);
      }
      onSent && onSent();
    } catch (err) {
      toast.error(err?.message || "Couldn't send SMS");
    } finally {
      setBusy(false);
    }
  };

  const palette = type === "not_arrived"
    ? "bg-red-600 hover:bg-red-700 text-white border-transparent"
    : "bg-amber-500 hover:bg-amber-600 text-white border-transparent";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      data-testid={`parent-notify-${type}-${member.id}`}
      className={`inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-bold border transition ${palette}`}
      title={type === "not_arrived" ? "SMS parents — child not arrived" : "SMS parents — child checked in late"}
    >
      {busy ? <Loader2 size={10} className="animate-spin" /> : <Send size={10} />}
      {type === "not_arrived" ? "Notify parents" : "Late SMS"}
    </button>
  );
}
