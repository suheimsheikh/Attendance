import React from "react";
import { Edit3, Trash2, PencilRuler, Archive, ArchiveRestore } from "lucide-react";
import InlinePhotoAvatar from "../../../components/InlinePhotoAvatar";
import ParentContact from "../../../components/ParentContact";
import InlineCell from "../../../components/InlineCell";
import ExMemberChip from "../../../components/ExMemberChip";
import MemberDetailsLine from "./MemberDetailsLine";
import { BUCKET_BY_KEY, bucketOf, isInteractive } from "./helpers";

/**
 * MemberRow — one `<tr>` for a single member in the Members admin table.
 *
 * Extracted from Members.jsx (which was 753 lines; the row template alone
 * was ~210 of those). All mutation goes through callbacks passed in by
 * the parent — this component is purely presentational + relays edits.
 *
 * Props:
 *   m              — the member doc
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
 *   cols           — visible movable column defs (useMemberColumns)
 *   idNum / onSaveIdNum — member's own PAN/Aadhaar + inline saver
 */
export default React.memo(function MemberRow({
  m, today, presenceRow, busyId,
  options,
  onEdit, onDelete, onToggleAttendance, onPatchField,
  onPhotoUpdated,
  onFileCorrection,
  onArchive, onUnarchive,
  highlighted,
  cols, idNum, onSaveIdNum,
}) {
  const b = BUCKET_BY_KEY[bucketOf(m)] || BUCKET_BY_KEY.athlete;
  const ctx = { options, onPatchField, today, presenceRow, busyId, onToggleAttendance, idNum, onSaveIdNum };
  // Frozen-column background — sticky td cells must have their own solid
  // background or the un-frozen columns scroll through them. Pick the same
  // tone the row would show for its state (highlighted → amber, otherwise
  // white). Bucket hover tints are dropped on frozen cells by design.
  const frozenBg = highlighted ? "bg-amber-50" : "bg-white";

  return (
    <>
    <tr
      className={`transition cursor-pointer ${
        highlighted ? "ring-2 ring-amber-400 bg-amber-50/60" : b.rowHover
      }`}
      data-testid={`member-row-${m.id}`}
      onDoubleClick={(e) => { if (!isInteractive(e.target)) onEdit(m); }}
      title="Double-click to edit"
    >
      {/* All action controls — extreme left, always visible (Jun 2026). */}
      <td className={`iu-table-td text-center relative pl-2 pr-1 sticky left-0 z-10 ${frozenBg}`}>
        <span className={`absolute left-0 top-2 bottom-2 w-1.5 rounded-r ${b.stripe}`} aria-hidden="true" />
        <div className="flex items-center justify-center gap-0.5">
          <button
            data-testid={`edit-member-${m.id}`}
            onClick={() => onEdit(m)}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-700"
            title="Edit member"
          >
            <Edit3 size={15} />
          </button>
          {onFileCorrection && (
            <button
              data-testid={`file-correction-${m.id}`}
              onClick={() => onFileCorrection(m)}
              className="p-1.5 rounded-lg hover:bg-sky-50 text-sky-700"
              title={`File correction on behalf of ${m.full_name}`}
            >
              <PencilRuler size={15} />
            </button>
          )}
          {m.archived ? (
            onUnarchive && (
              <button
                data-testid={`unarchive-member-${m.id}`}
                onClick={() => onUnarchive(m)}
                className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-700"
                title="Unarchive member (restore to all reports)"
              >
                <ArchiveRestore size={15} />
              </button>
            )
          ) : (
            onArchive && (
              <button
                data-testid={`archive-member-${m.id}`}
                onClick={() => onArchive(m)}
                className="p-1.5 rounded-lg hover:bg-amber-50 text-amber-700"
                title="Archive member (hide from all reports until unarchived)"
              >
                <Archive size={15} />
              </button>
            )
          )}
          <button
            data-testid={`delete-member-${m.id}`}
            onClick={() => onDelete(m)}
            className="p-1.5 rounded-lg hover:bg-red-50 text-red-600"
            title="Delete member"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </td>
      {/* Member: photo + name + email + parent-contact icon */}
      <td className={`iu-table-td sticky left-28 z-10 ${frozenBg} shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]`}>
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
      {/* Movable columns (Columns menu / drag headers) — see ./columns.jsx */}
      {cols.map((c) => (
        <td key={c.key} className={`iu-table-td text-slate-700 ${c.tdClass || ""}`} data-testid={c.tdTestId?.(m)}>
          {c.cell(m, ctx)}
        </td>
      ))}
    </tr>
    <MemberDetailsLine m={m} colSpan={cols.length} onPatchField={onPatchField} idNum={idNum} onSaveIdNum={onSaveIdNum} frozenBg={frozenBg} />
    </>
  );
});
