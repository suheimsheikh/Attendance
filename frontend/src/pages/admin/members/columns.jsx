import React from "react";
import { ShieldCheck, ChefHat, LogIn, LogOut as LogOutIcon, Loader2 } from "lucide-react";
import InlineCell from "../../../components/InlineCell";
import StatusBadge from "../../../components/StatusBadge";
import ParentInlineInput from "./ParentInlineInput";
import { BUCKET_BY_KEY, GENDER_LABEL, lastSeenLabel, leaveBalanceLabel } from "./helpers";

/**
 * Movable Members-table columns (Oct 2026). Each column renders its own <td>
 * content; Actions + Member stay frozen on the left (see MemberRow).
 * `cell(m, ctx)` — ctx: { options, onPatchField, today, presenceRow, busyId,
 * onToggleAttendance, idNum, onSaveIdNum }. `isNew` columns start hidden.
 */
const dash = <span className="text-slate-300">—</span>;
const or = (v) => v || dash;
const fmtDate = (v) => {
  if (!v) return dash;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};
const pill = (on, yes, no) => (on
  ? <span className="inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">{yes}</span>
  : <span className="inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500 border border-slate-200">{no}</span>);
const BLOOD = ["", "A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((v) => ({ value: v, label: v || "—" }));

// Simple inline field: text/tel/date/checkbox/select bound to one member key.
// eslint-disable-next-line react/display-name
const field = (key, kind, extra = {}) => (m, { onPatchField }) => (
  <InlineCell kind={kind} value={kind === "checkbox" ? !!m[key] : m[key]} testId={`inline-${key}-${m.id}`}
    onSave={(v) => onPatchField(m.id, key, v)}
    renderDisplay={kind === "date" ? fmtDate : kind === "checkbox" ? (v) => pill(v, "Yes", "No") : (v) => or(v)} {...extra} />
);

const MealToggle = ({ m, onPatchField }) => {
  const v = m.meal_eligible;
  const cls = v === false ? "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100"
    : v === true ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
    : "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100";
  return (
    <button type="button" data-testid={`inline-meal_eligible-${m.id}`}
      onClick={() => onPatchField(m.id, "meal_eligible", v == null ? true : v === true ? false : null)}
      title={v === false ? "Meal OFF (excluded from every roster). Click to reset to auto."
        : v === true ? "Meal ON (always on the roster, even if the category is off). Click to force OFF."
        : "Meal auto — follows the category's meal_eligible flag. Click to override ON."}
      className={`inline-flex items-center px-2 h-5 rounded-full text-[10px] font-bold border ${cls}`}>
      {v === false ? "🍴 OFF" : v === true ? "🍴 ON" : "🍴 auto"}
    </button>
  );
};

const RoleBadge = ({ v, id }) => (v === "admin"
  ? <span data-testid={`admin-badge-${id}`} title="Has admin role — independent of category" className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[11px] font-bold border bg-indigo-50 text-indigo-700 border-indigo-200"><ShieldCheck size={11} /> Admin</span>
  : v === "chef"
    ? <span data-testid={`chef-badge-${id}`} title="Kitchen role — logs meal purchases and issues" className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[11px] font-bold border bg-amber-50 text-amber-800 border-amber-200"><ChefHat size={11} /> Chef</span>
    : <span title="Click to change role" className="inline-flex items-center gap-1 px-2 h-6 rounded-full text-[10px] font-semibold border bg-slate-50 text-slate-400 border-dashed border-slate-300"><ShieldCheck size={10} /> Member</span>);

const PARENTS = [["father", "bg-sky-100 text-sky-700", "F"], ["mother", "bg-pink-100 text-pink-700", "M"], ["guardian", "bg-violet-100 text-violet-700", "G"]];

// eslint-disable-next-line react/display-name
const idCell = (card) => (m, { idNum, onSaveIdNum }) => (
  <InlineCell kind="text" value={idNum?.[card] || ""} testId={`inline-${card}-${m.id}`} className="font-mono"
    onSave={(v) => onSaveIdNum(m.id, card, v)} renderDisplay={(v) => (v ? <span className="font-mono">{v}</span> : dash)} />
);

export const MEMBER_COLUMNS = [
  { key: "ot_meal", label: "OT / Meal", sortKey: "ot_eligible", align: "center", tdClass: "text-center",
    cell: (m, ctx) => (
      <div className="flex flex-col items-center gap-1">
        <InlineCell kind="checkbox" value={m.ot_eligible !== false} testId={`inline-ot_eligible-${m.id}`}
          onSave={(v) => ctx.onPatchField(m.id, "ot_eligible", v)} renderDisplay={(v) => pill(v, "OT ✓", "OT ✗")} />
        <MealToggle m={m} onPatchField={ctx.onPatchField} />
      </div>) },
  { key: "category", label: "Category", sortKey: "category",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.custom_category || m.category || "athlete"} options={options.CATEGORY_OPTS}
        testId={`inline-category-${m.id}`} onSave={(v) => onPatchField(m.id, "category", v)}
        renderDisplay={() => {
          const meta = BUCKET_BY_KEY[m.category || "athlete"] || BUCKET_BY_KEY.athlete;
          const custom = m.custom_category && options.CATEGORY_OPTS.find((o) => o.value === m.custom_category);
          return (
            <span className={`inline-flex items-center gap-1.5 px-2 h-6 rounded-full text-[11px] font-semibold border ${meta.inactiveBg} ${meta.inactiveText} ${meta.inactiveBorder}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${meta.dotBg}`} />
              {custom ? custom.label : (m.custom_category || meta.label.replace(/s$/, ""))}
            </span>);
        }} />) },
  { key: "role", label: "Role", sortKey: "role",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.role || "member"} options={options.ROLE_OPTS} testId={`inline-role-${m.id}`}
        onSave={(v) => onPatchField(m.id, "role", v)} renderDisplay={(v) => <RoleBadge v={v} id={m.id} />} />) },
  { key: "rank", label: "Rank", sortKey: "rank", cell: field("rank", "text") },
  { key: "gender", label: "Gender", sortKey: "gender",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.gender || ""} options={options.GENDER_OPTS} testId={`inline-gender-${m.id}`}
        onSave={(v) => onPatchField(m.id, "gender", v)} renderDisplay={(v) => (v ? GENDER_LABEL[v] : dash)} />) },
  { key: "mobile", label: "Mobile", sortKey: "mobile", tdClass: "font-mono text-xs", cell: field("mobile", "tel", { className: "font-mono" }) },
  { key: "institution", label: "Institution", sortKey: "institution",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.institution || ""} options={options.INSTITUTION_OPTS} testId={`inline-institution-${m.id}`}
        onSave={(v) => onPatchField(m.id, "institution", v)} renderDisplay={or} />) },
  { key: "fleet", label: "Fleet", sortKey: "fleet",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.fleet || ""} options={options.FLEET_OPTS} testId={`inline-fleet-${m.id}`}
        onSave={(v) => onPatchField(m.id, "fleet", v)}
        renderDisplay={(v) => (v ? <span className="inline-flex items-center px-2 h-5 rounded text-[11px] font-bold bg-sky-100 text-sky-700">{v}</span> : dash)} />) },
  { key: "last_seen", label: "Last seen", sortKey: "last_seen_date", tdClass: "text-xs whitespace-nowrap",
    tdTestId: (m) => `last-seen-${m.id}`, cell: (m, { today }) => lastSeenLabel(m.last_seen_date, today) },
  { key: "leave_balance", label: "Leave balance", sortKey: "leave_balance_opening", tdClass: "text-xs whitespace-nowrap",
    tdTestId: (m) => `leave-balance-${m.id}`,
    cell: (m, { onPatchField }) => ((m.category !== "athlete" && m.category !== "elite")
      ? <InlineCell kind="number" value={m.leave_balance_opening} testId={`inline-leave_balance_opening-${m.id}`}
          onSave={(v) => onPatchField(m.id, "leave_balance_opening", v)} renderDisplay={() => leaveBalanceLabel(m)} />
      : leaveBalanceLabel(m)) },
  { key: "hours", label: "Hours", sortKey: "work_start", tdClass: "text-xs whitespace-nowrap", tdTestId: (m) => `work-hours-${m.id}`,
    cell: (m, ctx) => (
      <div className="flex items-center gap-1">
        {field("work_start", "time", { renderDisplay: or })(m, ctx)}<span className="text-slate-300">–</span>{field("work_end", "time", { renderDisplay: or })(m, ctx)}
      </div>) },
  { key: "weekly_off", label: "Weekly off", sortKey: "weekly_off", tdClass: "text-xs",
    cell: (m, { options, onPatchField }) => (
      <InlineCell kind="select" value={m.weekly_off || ""} options={options.WEEKLY_OFF_OPTS} testId={`inline-weekly_off-${m.id}`}
        onSave={(v) => onPatchField(m.id, "weekly_off", v)} renderDisplay={(v) => (v ? <span className="capitalize">{v}</span> : dash)} />) },
  { key: "dob", label: "DOB", sortKey: "date_of_birth", tdClass: "text-xs whitespace-nowrap", cell: field("date_of_birth", "date") },
  { key: "parents", label: "Parents / Guardian", help: "parents",
    cell: (m, { onPatchField }) => (
      <div className="flex flex-col gap-0.5 min-w-[240px] max-w-[300px]">
        {PARENTS.map(([p, color, badge]) => (
          <ParentInlineInput key={p} memberId={m.id} field={`${p}_mobile`} nameField={`${p}_name`} nameValue={m[`${p}_name`]}
            initial={m[`${p}_mobile`]} onSave={onPatchField} colorClass={color} defaultBadge={badge} />))}
      </div>) },
  { key: "status", label: "Status", help: "status",
    cell: (m, { presenceRow: p, busyId, onToggleAttendance }) => (
      <div className="flex items-center gap-1">
        <button data-testid={`toggle-attendance-${m.id}`} disabled={busyId === m.id} onClick={() => onToggleAttendance(m)}
          title={p?.status === "on_campus" ? "Force check-out" : "Force check-in"} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-700">
          {busyId === m.id ? <Loader2 className="animate-spin" size={14} /> : (p?.status === "on_campus" ? <LogOutIcon size={14} /> : <LogIn size={14} />)}
        </button>
        {p ? <StatusBadge status={p.status} /> : <span className="text-xs text-slate-400">—</span>}
      </div>) },
  // ---- Added Oct 2026: hidden until ticked in the Columns menu ----
  { key: "email", label: "Email", sortKey: "email", isNew: true, tdClass: "text-xs", help: "Login email — changing it changes how admins sign in", cell: field("email", "text") },
  { key: "joining_date", label: "Joined", sortKey: "joining_date", isNew: true, tdClass: "text-xs whitespace-nowrap", cell: field("joining_date", "date") },
  { key: "leaving_date", label: "Left", sortKey: "leaving_date", isNew: true, tdClass: "text-xs whitespace-nowrap", cell: field("leaving_date", "date") },
  { key: "hourly_wager", label: "Hourly", sortKey: "hourly_wager", isNew: true, help: "Paid by hours only — max 8 h/day, never late or absent", cell: field("hourly_wager", "checkbox") },
  { key: "dar_required", label: "DAR required", sortKey: "dar_required", isNew: true, cell: field("dar_required", "checkbox") },
  { key: "dar_exempt", label: "DAR exempt", sortKey: "dar_exempt", isNew: true, cell: field("dar_exempt", "checkbox") },
  { key: "pan", label: "PAN", isNew: true, help: "Member's own PAN number (parents' are in the edit form / ID Documents)", cell: idCell("pan") },
  { key: "aadhaar", label: "Aadhaar", isNew: true, help: "Member's own Aadhaar number", cell: idCell("aadhaar") },
  { key: "blood_group", label: "Blood group", sortKey: "blood_group", isNew: true, cell: field("blood_group", "select", { options: BLOOD }) },
  { key: "address", label: "Address", sortKey: "address", isNew: true, tdClass: "text-xs min-w-[200px]", cell: field("address", "text") },
  { key: "emergency_contact_name", label: "Emergency contact", sortKey: "emergency_contact_name", isNew: true, cell: field("emergency_contact_name", "text") },
  { key: "emergency_contact_phone", label: "Emergency phone", sortKey: "emergency_contact_phone", isNew: true, tdClass: "font-mono text-xs", cell: field("emergency_contact_phone", "tel") },
  { key: "school_class", label: "Class / grade", sortKey: "school_class", isNew: true, cell: field("school_class", "text") },
  { key: "medical_notes", label: "Medical notes", sortKey: "medical_notes", isNew: true, tdClass: "text-xs min-w-[200px]", help: "Allergies, conditions, medication", cell: field("medical_notes", "text") },
];

export const COLUMN_BY_KEY = Object.fromEntries(MEMBER_COLUMNS.map((c) => [c.key, c]));
