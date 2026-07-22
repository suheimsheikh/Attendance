/**
 * ExMemberChip — small "LF" pill placed next to a member's name in any
 * list surface (Members, Presence, Muster, Reports table) when they
 * have a `leaving_date` in the past. Matches the Grid's LF cell tint
 * so admins immediately recognise the same status across the app.
 */
import React from "react";
import { isExMember } from "../utils/exMember";

export default function ExMemberChip({ member, className = "" }) {
  if (!isExMember(member)) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-slate-200 text-slate-500 border border-slate-300 ${className}`}
      title={`Left on ${member.leaving_date}`}
      data-testid={`ex-member-chip-${member.id}`}
    >
      LF
    </span>
  );
}
