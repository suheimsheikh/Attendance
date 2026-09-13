/**
 * useNotifyTemplates — one-shot fetch + module cache of the editable
 * bilingual parent-notify message templates (absent / late × Telugu /
 * English). Defaults mirror the backend so a fresh install / offline load
 * still produces sensible messages. Cache is cleared when an admin saves
 * templates in Office Settings (see NotifyTemplatesPanel).
 */
import { useEffect, useState } from "react";
import { api } from "../api";

export const NOTIFY_TEMPLATE_DEFAULTS = {
  absent_te:
    "నమస్తే 🙏\n\n{academy} నుండి {name} గురించి ఒక సందేశం.\n\n{name} ఈరోజు ({day}) శిక్షణకు హాజరు కాలేదు, మరియు మాకు ఎటువంటి ముందస్తు సమాచారం లేదు (అనుమతించిన సెలవు లేదా టూర్ నమోదు కాలేదు).\n\nదయచేసి వారి స్థితిని వీలైనంత త్వరగా తెలియజేయండి. ధన్యవాదాలు.",
  absent_en:
    "Namaste 🙏\n\nThis is a note from {academy} regarding {name}.\n\n{name} has not reported for training today ({day}) and we have no prior information (no approved leave or tour on record).\n\nKindly confirm their status at your earliest. Thank you.",
  late_te:
    "నమస్తే 🙏\n\n{academy} నుండి {name} గురించి ఒక సందేశం.\n\n{name} ఈరోజు ({day}) శిక్షణకు {time} గంటలకు ఆలస్యంగా హాజరయ్యారు ({minutes} నిమిషాలు ఆలస్యం).\n\nదయచేసి సమయపాలన పాటించేలా చూడగలరు. ధన్యవాదాలు.",
  late_en:
    "Namaste 🙏\n\nThis is a note from {academy} regarding {name}.\n\n{name} arrived late for training today ({day}) at {time} — {minutes} minutes late.\n\nKindly help ensure punctuality going forward. Thank you.",
};

let _cache = null;

export function clearNotifyTemplatesCache() { _cache = null; }

export default function useNotifyTemplates() {
  const [tpl, setTpl] = useState(_cache || NOTIFY_TEMPLATE_DEFAULTS);
  useEffect(() => {
    if (_cache) return;
    let ignore = false;
    api.get("/notify/templates")
      .then((res) => {
        if (ignore) return;
        _cache = { ...NOTIFY_TEMPLATE_DEFAULTS, ...(res || {}) };
        setTpl(_cache);
      })
      .catch(() => { /* keep defaults on network error */ });
    return () => { ignore = true; };
  }, []);
  return tpl;
}
