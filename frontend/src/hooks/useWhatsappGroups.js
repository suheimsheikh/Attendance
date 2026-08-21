/**
 * useWhatsappGroups — one-shot fetch + cache of the two WhatsApp group
 * names (`staff` / `athletes`) that are prepended to every share
 * caption produced by `shareToWhatsApp`.
 *
 * Uses the `staticGet` cache in `api.js` so we don't re-hit the server
 * on every share button click; the cache is invalidated when settings
 * are saved (see AdminOfficePage).
 */
import { useEffect, useState } from "react";
import { api } from "../api";

const DEFAULTS = {
  staff_group_name: "YCH Attendance",
  athletes_group_name: "YCH Parents & Guardians Group",
};

let _cache = null;   // module-level cache; cleared by clearWhatsappGroupsCache

export function clearWhatsappGroupsCache() { _cache = null; }

export default function useWhatsappGroups() {
  const [groups, setGroups] = useState(_cache || DEFAULTS);
  useEffect(() => {
    if (_cache) return;
    let ignore = false;
    api.get("/config/whatsapp-groups")
      .then((res) => {
        if (ignore) return;
        _cache = { ...DEFAULTS, ...(res || {}) };
        setGroups(_cache);
      })
      .catch(() => { /* keep defaults on network error */ });
    return () => { ignore = true; };
  }, []);
  return groups;
}

/**
 * Compose the "📊 *Attendance Report for X*" header for a WhatsApp
 * share. `audience` is either "staff" or "athletes" and is decided by
 * the calling screen based on context (Muster = athletes, admin summary
 * = staff). Returns a header string ready to be prepended to the caller's
 * existing caption.
 *
 *   📊 *Attendance Report for YCH Parents & Guardians Group*
 *   📅 Date: Mon 26/02/26
 */
export function buildWhatsappHeader({ audience, groups, dateIso }) {
  const name = audience === "staff"
    ? (groups?.staff_group_name || DEFAULTS.staff_group_name)
    : (groups?.athletes_group_name || DEFAULTS.athletes_group_name);
  const dt = dateIso
    ? new Date(dateIso + "T00:00:00").toLocaleDateString("en-GB", {
        weekday: "short", day: "2-digit", month: "short", year: "2-digit",
      })
    : new Date().toLocaleDateString("en-GB", {
        weekday: "short", day: "2-digit", month: "short", year: "2-digit",
      });
  return `📊 *Attendance Report for ${name}*\n📅 Date: ${dt}\n`;
}
