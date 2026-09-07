import React from "react";
import { Edit3, LogIn, LogOut as LogOutIcon, Loader2, Trash2, ShieldCheck, PencilRuler, ChefHat } from "lucide-react";
import InlinePhotoAvatar from "../../../components/InlinePhotoAvatar";
import ParentContact from "../../../components/ParentContact";
import StatusBadge from "../../../components/StatusBadge";
import InlineCell from "../../../components/InlineCell";
import ParentInlineInput from "./ParentInlineInput";
import ExMemberChip from "../../../components/ExMemberChip";
import { BUCKET_BY_KEY, GENDER_LABEL, bucketOf, isInteractive, lastSeenLabel, leaveBalanceLabel } from "./helpers";

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
export default React.memo(function MemberRow({
  m, rowIdx, today, presenceRow, busyId,
  options,
  onEdit, onDelete, onToggleAttendance, onPatchField,
  onPhotoUpdated,
  onFileCorrection,
  highlighted,
}) {
  const p = presenceRow;
  const b = BUCKET_BY_KEY[bucketOf(m)] || BUCKET_BY_KEY.athlete;
  const { CATEGORY_OPTS, ROLE_OPTS, GENDER_OPTS, FLEET_OPTS, INSTITUTION_OPTS, WEEKLY_OFF_OPTS } = options;
  // Friendly DOB display — "12 Mar 2005" instead of raw "2005-03-12".
  const dobDisplay = (v) => {
    if (!v) return <span className="text-slate-300">—</span>;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  // Frozen-column background — sticky td cells must have their own solid
  // background or the un-frozen columns scroll through them. Pick the same
  // tone the row would show for its state (highlighted → amber, otherwise
  // white). Bucket hover tints are dropped on frozen cells by design.
  const frozenBg = highlighted ? "bg-amber-50" : "bg-white";

  return (
    <tr
      className={`transition cursor-pointer ${
        highlighted ? "ring-2 ring-amber-400 bg-amber-50/60" : b.rowHover
      }`}
      data-testid={`member-row-${m.id}`}
      onDoubleClick={(e) => { if (!isInteractive(e.target)) onEdit(m); }}
      title="Double-click to edit"
    >
      {/* Edit pencil + File-correction — extreme left, always visible */}
      <td className={`iu-table-td text-center relative pl-2 pr-1 sticky left-0 z-10 ${frozenBg}`}>
        <span className={`absolute left-0 top-2 bottom-2 w-1.5 rounded-r ${b.stripe}`} aria-hidden="true" />
        <div className="flex items-center justify-center gap-0.5">
          <button
            data-testid={`edit-member-${m.id}`}
            onClick={() => onEdit(m)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-700"
            title="Edit member"
          >
            <Edit3 size={16} />
          </button>
          {onFileCorrection && (
            <button
              data-testid={`file-correction-${m.id}`}
              onClick={() => onFileCorrection(m)}
              className="p-2 rounded-lg hover:bg-sky-50 text-sky-700"
              title={`File correction on behalf of ${m.full_name}`}
            >
              <PencilRuler size={16} />
            </button>
          )}
        </div>
      </td>
      {/* Member: photo + name + email + parent-contact icon */}
      <td className={`iu-table-td sticky left-16 z-10 ${frozenBg} shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]`}>
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
              <ExMemberChip member={m} />
              <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
            </div>
            <div className="text-xs text-slate-500 truncate">{m.email}</div>
          </div>
        </div>
      </td>
      {/* OT + Meal eligibility — placed immediately after the sticky
          Member column so at-a-glance status is visible before you have
          to scroll into the wider payroll data. 20 Feb 2026 chef request. */}
      <td className="iu-table-td text-center">
        <div className="flex flex-col items-center gap-1">
          <InlineCell
            kind="checkbox"
            value={m.ot_eligible !== false}
            testId={`inline-ot_eligible-${m.id}`}
            onSave={(v) => onPatchField(m.id, "ot_eligible", v)}
            renderDisplay={(v) => v
              ? <span className="inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">OT ✓</span>
              : <span className="inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">OT ✗</span>}
          />
          {/* Per-member meal eligibility override (Feb 2026). Cycles:
              inherit (null, category rules) → explicit ON → explicit OFF → inherit.
              A member with an explicit False is skipped from every meal roster
              even if their category is meal_eligible; a member with explicit
              True appears on the roster even if their category is off. */}
          <button
            type="button"
            onClick={() => {
              const cur = m.meal_eligible;
              const next = cur == null ? true : cur === true ? false : null;
              onPatchField(m.id, "meal_eligible", next);
            }}
            title={
              m.meal_eligible === false
                ? "Meal OFF (excluded from every roster). Click to reset to auto."
                : m.meal_eligible === true
                ? "Meal ON (always on the roster, even if the category is off). Click to force OFF."
                : "Meal auto — follows the category's meal_eligible flag. Click to override ON."
            }
            className={
              m.meal_eligible === false
                ? "inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100"
                : m.meal_eligible === true
                ? "inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
                : "inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-slate-50 text-slate-500 border border-slate-200 hover:bg-slate-100"
            }
            data-testid={`inline-meal_eligible-${m.id}`}
          >
            {m.meal_eligible === false ? "🍴 OFF"
              : m.meal_eligible === true ? "🍴 ON"
              : "🍴 auto"}
          </button>
        </div>
      </td>
      {/* Category — inline-editable pill (colour keyed to the category). */}
      <td className="iu-table-td">
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
      </td>
      {/* Role — orthogonal to category (a coach can also be admin). */}
      <td className="iu-table-td">
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
            ) : v === "chef" ? (
              // Feb 2026 · bug fix — pre-fix the Role column collapsed
              // every non-admin role (including chef) to "Member",
              // which made the Chef filter look broken ("filtered
              // chefs still show up as Members").
              <span
                data-testid={`chef-badge-${m.id}`}
                className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[11px] font-bold border bg-amber-50 text-amber-800 border-amber-200"
                title="Kitchen role — logs meal purchases and issues"
              >
                <ChefHat size={11} /> Chef
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-semibold border bg-slate-50 text-slate-400 border-dashed border-slate-300" title="Click to change role">
                <ShieldCheck size={10} /> Member
              </span>
            )
          )}
        />
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
      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap" data-testid={`work-hours-${m.id}`}>
        <div className="flex items-center gap-1">
          <InlineCell
            kind="time"
            value={m.work_start}
            testId={`inline-work_start-${m.id}`}
            onSave={(v) => onPatchField(m.id, "work_start", v)}
            renderDisplay={(v) => v || <span className="text-slate-300">—</span>}
          />
          <span className="text-slate-300">–</span>
          <InlineCell
            kind="time"
            value={m.work_end}
            testId={`inline-work_end-${m.id}`}
            onSave={(v) => onPatchField(m.id, "work_end", v)}
            renderDisplay={(v) => v || <span className="text-slate-300">—</span>}
          />
        </div>
      </td>
      <td className="iu-table-td text-slate-700 text-xs">
        <InlineCell
          kind="select"
          value={m.weekly_off || ""}
          options={WEEKLY_OFF_OPTS}
          testId={`inline-weekly_off-${m.id}`}
          onSave={(v) => onPatchField(m.id, "weekly_off", v)}
          renderDisplay={(v) => v
            ? <span className="capitalize">{v}</span>
            : <span className="text-slate-300">—</span>}
        />
      </td>
      {/* Date of birth — powers the birthday greeting on check-in. */}
      <td className="iu-table-td text-slate-700 text-xs whitespace-nowrap">
        <InlineCell
          kind="date"
          value={m.date_of_birth}
          testId={`inline-date_of_birth-${m.id}`}
          onSave={(v) => onPatchField(m.id, "date_of_birth", v)}
          renderDisplay={dobDisplay}
        />
      </td>
      {/* Inline editable parent names + mobile numbers. Names are edited via
          a small text InlineCell in place of the old static badge label. */}
      <td className="iu-table-td">
        <div className="flex flex-col gap-0.5 min-w-[240px] max-w-[300px]">
          <ParentInlineInput
            memberId={m.id}
            field="father_mobile"
            nameField="father_name"
            nameValue={m.father_name}
            initial={m.father_mobile}
            onSave={onPatchField}
            colorClass="bg-sky-100 text-sky-700"
            defaultBadge="F"
          />
          <ParentInlineInput
            memberId={m.id}
            field="mother_mobile"
            nameField="mother_name"
            nameValue={m.mother_name}
            initial={m.mother_mobile}
            onSave={onPatchField}
            colorClass="bg-pink-100 text-pink-700"
            defaultBadge="M"
          />
          <ParentInlineInput
            memberId={m.id}
            field="guardian_mobile"
            nameField="guardian_name"
            nameValue={m.guardian_name}
            initial={m.guardian_mobile}
            onSave={onPatchField}
            colorClass="bg-violet-100 text-violet-700"
            defaultBadge="G"
          />
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
        <div className="flex items-center justify-center gap-1">
          <button data-testid={`delete-member-${m.id}`} onClick={() => onDelete(m)} className="p-2 rounded-lg hover:bg-red-50 text-red-600" title="Delete member">
            <Trash2 size={16} />
          </button>
        </div>
      </td>
    </tr>
  );
});
