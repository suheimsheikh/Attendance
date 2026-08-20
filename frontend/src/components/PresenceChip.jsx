import React from "react";
import { Users } from "lucide-react";
import Avatar from "./Avatar";
import { usePresence } from "../hooks/usePresence";

/**
 * PresenceChip — small "online now" indicator showing avatars of
 * fellow chefs/admins currently active. Auto-heartbeats via
 * `usePresence`. Only mounted on Muster + Pantry pages (Feb 2026
 * user request — not the whole app).
 *
 * @param {string} where — context tag sent to the server so peers
 *                         can see WHERE this user is (Muster / Pantry).
 */
export default function PresenceChip({ where }) {
  const { online } = usePresence(where);
  // Show up to 4 avatars inline; overflow becomes a "+N" pill.
  const shown = online.slice(0, 4);
  const overflow = Math.max(0, online.length - shown.length);
  if (!online.length) return null;
  return (
    <div
      data-testid="presence-chip"
      title={`Online now: ${online.map((u) => `${u.name}${u.where ? " (" + u.where + ")" : ""}`).join(", ")}`}
      className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-1 text-emerald-800"
    >
      <Users size={12} className="shrink-0"/>
      <span className="text-[10px] font-bold uppercase tracking-wider">Online</span>
      <div className="flex -space-x-1.5">
        {shown.map((u) => (
          <span key={u.id} className="inline-block ring-2 ring-emerald-50 rounded-full" title={`${u.name} · ${u.role}${u.where ? " · " + u.where : ""}`}>
            <Avatar name={u.name} photo={u.photo} size={20}/>
          </span>
        ))}
      </div>
      {overflow > 0 && (
        <span className="ml-1 text-[10px] font-bold text-emerald-700">+{overflow}</span>
      )}
    </div>
  );
}
