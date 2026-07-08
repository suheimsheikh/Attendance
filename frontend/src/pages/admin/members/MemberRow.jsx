import React from "react";
import { Edit3, LogIn, LogOut as LogOutIcon, Loader2, Trash2, ShieldCheck } from "lucide-react";
import InlinePhotoAvatar from "../../../components/InlinePhotoAvatar";
import ParentContact from "../../../components/ParentContact";
import StatusBadge from "../../../components/StatusBadge";
import InlineCell from "../../../components/InlineCell";
import ParentInlineInput from "./ParentInlineInput";
import { BUCKET_BY_KEY, GENDER_LABEL, bucketOf, isInteractive, lastSeenLabel, leaveBalanceLabel } from "./helpers";
import { categoryLabel } from "../../../utils";

/**
 * MemberRow — one `<tr>` for a single member in the Members admin table.
 *
 * Extracted from Members.jsx (which was 753 lines; the row template alone
 * was ~210 of those). All mutation goes through callbacks passed in by
 * the parent — this component is purely presentational + relays edits.
 *
 * Props:
 *   m              — the member doc
 *   rowIdx         — index in the filtered list (drives shift-click ranges)
 *   today          — local YYYY-MM-DD, used by lastSeenLabel
 *   presenceRow    — the matching row from /presence (or undefined)
 *   busyId         — the id currently mid-toggle (drives the spinner)
 *   isSelected     — bulk-edit selection state
 *   shiftHeldRef   — ref tracking the global Shift key state
 *   options        — pre-built select option arrays (category/role/gender/
 *                    fleet/institution) so we don't rebuild them per row
 *   onEdit         — open the full-edit modal for this member
 *   onDelete       — handler for the row-level delete button
 *   onToggleAttendance — force check-in/out
 *   onPatchField   — inline-cell save; (memberId, field, value) → Promise
 *   onToggleRow    — bulk-edit checkbox handler (memberId, rowIdx, shiftKey)
 *   onPhotoUpdated — fires after the InlinePhotoAvatar saves a new photo
 */
export default function MemberRow({
  m, rowIdx, today, presenceRow, busyId, isSelected, shiftHeldRef,
  options,
  onEdit, onDelete, onToggleAttendance, onPatchField, onToggleRow,
  onPhotoUpdated,
  highlighted,
}) {
  const p = presenceRow;
  const b = BUCKET_BY_KEY[bucketOf(m)] || BUCKET_BY_KEY.athlete;
  const { CATEGORY_OPTS, ROLE_OPTS, GENDER_OPTS, FLEET_OPTS, INSTITUTION_OPTS } = options;

  return (
    <tr
      className={`transition cursor-pointer ${
        highlighted ? "ring-2 ring-amber-400 bg-amber-50/60" :
        isSelected ? "bg-sky-50/80" : b.rowHover
      }`}
      data-testid={`member-row-${m.id}`}
      onDoubleClick={(e) => { if (!isInteractive(e.target)) onEdit(m); }}
      title="Double-click to edit · click checkbox + shift-click for bulk select"
    >
      {/* Selection checkbox. Shift state is captured via a synchronous
          `onMouseDown` handler (fires BEFORE both click and change events,
          regardless of synthetic-event ordering quirks). The wrapper td's
          onClick deliberately swallows propagation so the row's
          double-click-to-edit doesn't trigger. */}
      <td className="iu-table-td text-center" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          data-testid={`bulk-select-${m.id}`}
          checked={isSelected}
          onMouseDown={(e) => { shiftHeldRef.current = !!e.shiftKey; }}
          onKeyDown={(e) => { shiftHeldRef.current = !!e.shiftKey; }}
          onChange={() => onToggleRow(m.id, rowIdx, shiftHeldRef.current)}
          className="w-4 h-4 cursor-pointer accent-sky-600"
        />
      </td>
      {/* Edit pencil — extreme left, always visible */}
      <td className="iu-table-td text-center relative pl-2 pr-1">
        <span className={`absolute left-0 top-2 bottom-2 w-1.5 rounded-r ${b.stripe}`} aria-hidden="true" />
        <button
          data-testid={`edit-member-${m.id}`}
          onClick={() => onEdit(m)}
          className="p-2 rounded-lg hover:bg-slate-100 text-slate-700"
          title="Edit member"
        >
          <Edit3 size={16} />
        </button>
      </td>
      {/* Member: photo + name + email + parent-contact icon */}
      <td className="iu-table-td">
        <div className="flex items-center gap-3">
          <InlinePhotoAvatar
            member={m}
            size={40}
            onUpdated={onPhotoUpdated}
          />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-900 truncate flex items-center gap-2">
              <InlineCell
                kind="text"
                value={m.full_name}
                required
                testId={`inline-full_name-${m.id}`}
                onSave={(v) => onPatchField(m.id, "full_name", v)}
                className="text-sm font-semibold"
              />
              <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
            </div>
            <div className="text-xs text-slate-500 truncate">{m.email}</div>
          </div>
        </div>
      </td>
      {/* Role / category — both inline-editable. Category is a select that
          renders the colored pill; admin role is a select that renders the
          indigo shield badge. */}
      <td className="iu-table-td">
        <div className="flex items-center gap-1.5 flex-wrap">
          <InlineCell
            kind="select"
            value={m.category || "athlete"}
            options={CATEGORY_OPTS}
            testId={`inline-category-${m.id}`}
            onSave={(v) => onPatchField(m.id, "category", v)}
            renderDisplay={(v) => {
              const cat = v || "athlete";
              const meta = BUCKET_BY_KEY[cat] || BUCKET_BY_KEY.athlete;
              return (
                <span className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${meta.inactiveBg} ${meta.inactiveText} ${meta.inactiveBorder}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${meta.dotBg}`} />
                  {meta.label.replace(/s$/, "")}
                </span>
              );
            }}
          />
          <InlineCell
            kind="select"
            value={m.role || "member"}
            options={ROLE_OPTS}
            testId={`inline-role-${m.id}`}
            onSave={(v) => onPatchField(m.id, "role", v)}
            renderDisplay={(v) => (
              v === "admin" ? (
                <span
                  data-testid={`admin-badge-${m.id}`}
                  className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[11px] font-bold border bg-indigo-50 text-indigo-700 border-indigo-200"
                  title="Has admin role — independent of category"
                >
                  <ShieldCheck size={11} /> Admin
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-semibold border bg-slate-50 text-slate-400 border-dashed border-slate-300" title="Click to grant admin">
                  <ShieldCheck size={10} /> Member
                </span>
              )
            )}
          />
        </div>
        <div className="text-xs text-slate-500 mt-1">{categoryLabel(m.category)}</div>
      </td>
      <td className="iu-table-td text-slate-700">
        <InlineCell
          kind="text"
          value={m.rank}
          testId={`inline-rank-${m.id}`}
          onSave={(v) => onPatchField(m.id, "rank", v)}
        />
      </td>
      <td className="iu-table-td text-slate-700">
        <InlineCell
          kind="select"
          value={m.gender || ""}
          options={GENDER_OPTS}
          testId={`inline-gender-${m.id}`}
          onSave={(v) => onPatchField(m.id, "gender", v)}
          renderDisplay={(v) => v ? GENDER_LABEL[v] : <span className="text-slate-300">—</span>}
        />
      </td>
      <td className="iu-table-td text-slate-700 font-mono text-xs">
        <InlineCell
          kind="tel"
          value={m.mobile}
          testId={`inline-mobile-${m.id}`}
          onSave={(v) => onPatchField(m.id, "mobile", v)}
          className="font-mono"
        />
      </td>
      <td className="iu-table-td text-slate-700">
        <InlineCell
          kind="select"
          value={m.institution || ""}
          options={INSTITUTION_OPTS}
          testId={`inline-institution-${m.id}`}
          onSave={(v) => onPatchField(m.id, "institution", v)}
          renderDisplay={(v) => v || <span className="text-slate-300">—</span>}
        />
      </td>
      <td className="iu-table-td text-slate-700">
        <InlineCell
          kind="select"
          value={m.fleet || ""}
          options={FLEET_OPTS}
          testId={`inline-fleet-${m.id}`}
          onSave={(v) => onPatchField(m.id, "fleet", v)}
          renderDisplay={(v) => v ? (
            <span className="inline-flex items-center px-2 h-5 rounded text-[11px] font-bold bg-sky-100 text-sky-700">{v}</span>
          ) : <span className="text-slate-300">—</span>}
        />
      </td>
      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap" data-testid={`last-seen-${m.id}`}>
        {lastSeenLabel(m.last_seen_date, today)}
      </td>
      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap" data-testid={`leave-balance-${m.id}`}>
        {(m.category !== "athlete" && m.category !== "elite") ? (
          <InlineCell
            kind="number"
            value={m.leave_balance_opening}
            testId={`inline-leave_balance_opening-${m.id}`}
            onSave={(v) => onPatchField(m.id, "leave_balance_opening", v)}
            renderDisplay={() => leaveBalanceLabel(m)}
          />
        ) : leaveBalanceLabel(m)}
      </td>
      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap">
        {m.work_start || "—"}{m.work_end ? <> – {m.work_end}</> : null}
      </td>
      <td className="iu-table-td text-slate-700 text-xs capitalize">{m.weekly_off || "—"}</td>
      {/* Inline editable parent mobile numbers, prefixed with the parent's
          NAME (read-only here — names are edited via the row's edit modal). */}
      <td className="iu-table-td">
        <div className="flex flex-col gap-1 min-w-[320px] max-w-[420px]">
          <ParentInlineInput memberId={m.id} field="father_mobile" label={m.father_name || "F"} initial={m.father_mobile} onSave={onPatchField} />
          <ParentInlineInput memberId={m.id} field="mother_mobile" label={m.mother_name || "M"} initial={m.mother_mobile} onSave={onPatchField} />
          <ParentInlineInput memberId={m.id} field="guardian_mobile" label={m.guardian_name || "G"} initial={m.guardian_mobile} onSave={onPatchField} />
        </div>
      </td>
      <td className="iu-table-td">
        <div className="flex items-center gap-1">
          <button
            data-testid={`toggle-attendance-${m.id}`}
            disabled={busyId === m.id}
            onClick={() => onToggleAttendance(m)}
            title={p?.status === "on_campus" ? "Force check-out" : "Force check-in"}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-700"
          >
            {busyId === m.id ? <Loader2 className="animate-spin" size={14}/> : (p?.status === "on_campus" ? <LogOutIcon size={14}/> : <LogIn size={14}/>)}
          </button>
          {p ? <StatusBadge status={p.status} /> : <span className="text-xs text-slate-400">—</span>}
        </div>
      </td>
      <td className="iu-table-td text-center">
        <button data-testid={`delete-member-${m.id}`} onClick={() => onDelete(m)} className="p-2 rounded-lg hover:bg-red-50 text-red-600" title="Delete member">
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );
}
