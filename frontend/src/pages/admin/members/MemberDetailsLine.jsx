import React from "react";
import InlineCell from "../../../components/InlineCell";

/**
 * MemberDetailsLine — a second, always-visible row under each member that
 * surfaces the important profile fields inline-editable (user, Jun 2026), so
 * admins don't have to open the modal or enable extra columns for them.
 *
 * Rendered as a sibling <tr> by MemberRow. The two leading cells mirror the
 * frozen Actions + Member columns so everything stays aligned while the table
 * scrolls horizontally; the rest is one colSpan strip that wraps freely.
 */
const BLOOD = ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((v) => ({ value: v, label: v || "—" }));
const dash = <span className="text-slate-300">—</span>;
const fmtDate = (v) => {
  if (!v) return dash;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const Field = ({ label, children }) => (
  <div className="flex items-center gap-1.5 shrink-0">
    <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400 whitespace-nowrap">{label}</span>
    {children}
  </div>
);

export default React.memo(function MemberDetailsLine({ m, colSpan, onPatchField, idNum, onSaveIdNum, frozenBg }) {
  const cell = (key, kind, extra = {}) => (
    <InlineCell
      kind={kind}
      value={kind === "checkbox" ? !!m[key] : (m[key] ?? "")}
      testId={`detail-${key}-${m.id}`}
      onSave={(v) => onPatchField(m.id, key, v)}
      renderDisplay={kind === "date" ? fmtDate : (v) => (v === "" || v == null ? dash : String(v))}
      {...extra}
    />
  );
  const idCell = (card) => (
    <InlineCell
      kind="text"
      value={idNum?.[card] || ""}
      testId={`detail-${card}-${m.id}`}
      className="font-mono"
      onSave={(v) => onSaveIdNum(m.id, card, v)}
      renderDisplay={(v) => (v ? <span className="font-mono">{v}</span> : dash)}
    />
  );
  return (
    <tr className="bg-slate-50/60" data-testid={`member-details-${m.id}`}>
      <td className={`sticky left-0 z-10 ${frozenBg} border-b-2 border-slate-200`} />
      <td className={`sticky left-28 z-10 ${frozenBg} border-b-2 border-slate-200 shadow-[2px_0_4px_-2px_rgba(0,0,0,0.15)]`}>
        <span className="pl-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">Details</span>
      </td>
      <td colSpan={colSpan} className="px-4 py-1.5 border-b-2 border-slate-200">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-slate-700">
          <Field label="DOB">{cell("date_of_birth", "date")}</Field>
          <Field label="Blood">{cell("blood_group", "select", { options: BLOOD })}</Field>
          <Field label="Joined">{cell("joining_date", "date")}</Field>
          <Field label="Left">{cell("leaving_date", "date")}</Field>
          <Field label="Class">{cell("school_class", "text")}</Field>
          <Field label="PAN">{idCell("pan")}</Field>
          <Field label="Aadhaar">{idCell("aadhaar")}</Field>
          <Field label="Passport">{idCell("passport")}</Field>
          <Field label="Address">{cell("address", "text", { className: "min-w-[120px]" })}</Field>
          <Field label="Emergency">{cell("emergency_contact_name", "text")}</Field>
          <Field label="Phone">{cell("emergency_contact_phone", "tel", { className: "font-mono" })}</Field>
          <Field label="Medical">{cell("medical_notes", "text", { className: "min-w-[120px]" })}</Field>
        </div>
      </td>
    </tr>
  );
});
