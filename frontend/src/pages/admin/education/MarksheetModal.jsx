import React, { useState } from "react";
import { Loader2, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Safe month label — tolerates a missing/out-of-range month on a malformed sheet.
export const monLabel = (m) => MONTHS[m - 1] || "";
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const nowYear = new Date().getFullYear();

function Field({ label, children }) {
  return <div><label className="iu-label">{label}</label>{children}</div>;
}

// Add / edit one marksheet. Picking a scan reads it with AI to pre-fill the form.
export default function MarksheetModal({ member, sheet, onClose, onSaved }) {
  const [f, setF] = useState({
    exam_name: sheet?.exam_name || "", month: sheet?.month || "", year: sheet?.year || "",
    board: sheet?.board || "", result: sheet?.result || "", notes: sheet?.notes || "", sheet_name: sheet?.sheet_name || "",
  });
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  const pick = async (e) => {
    const fl = e.target.files?.[0];
    e.target.value = "";
    if (!fl) return;
    if (fl.size > 10 * 1024 * 1024) { toast.error("File must be under 10 MB"); return; }
    setFile(fl);
    setReading(true);
    try {
      const form = new FormData();
      form.append("file", fl);
      form.append("member_id", member.id);
      const { detected: d } = await api.post("/education/read", form);
      if (!d) { toast.info("Couldn't read the marksheet — please type the details"); return; }
      setF((x) => ({ ...x, exam_name: d.exam_name || x.exam_name, month: d.month || x.month, year: d.year || x.year,
        board: d.board || x.board, result: d.result || x.result, sheet_name: d.name || "" }));
      setCheck(d);
      toast.success("Details read from the scan — please check them");
    } catch (err) { showApiError(err, "Couldn't read the scan"); } finally { setReading(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const form = new FormData();
      Object.entries(f).forEach(([k, v]) => form.append(k, v ?? ""));
      if (file) form.append("file", file);
      if (sheet) await api.patch(`/education/marksheets/${sheet.id}`, form);
      else await api.post(`/education/members/${member.id}/marksheets`, form);
      toast.success(sheet ? "Marksheet updated" : "Marksheet added");
      onSaved();
    } catch (err) { showApiError(err, "Couldn't save the marksheet"); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} data-testid="marksheet-modal"
        className="bg-white w-full md:max-w-xl rounded-t-2xl md:rounded-2xl p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div>
          <h2 className="text-lg font-extrabold">{sheet ? "Edit marksheet" : "Add marksheet"}</h2>
          <p className="text-xs text-slate-500">{member.full_name}</p>
        </div>
        <label className="flex items-center gap-2 border-2 border-dashed border-slate-300 rounded-xl p-3 cursor-pointer hover:border-sky-500 text-sm"
          title="Scan with the camera or pick a PDF / photo — the AI fills the details for you">
          {reading ? <Loader2 size={16} className="animate-spin" /> : <ScanLine size={16} />}
          <span className="font-semibold">{reading ? "Reading the marksheet…" : file ? file.name : sheet?.file_name ? `Replace scan (${sheet.file_name})` : "Scan / upload marksheet"}</span>
          <input type="file" accept={ACCEPT} className="hidden" onChange={pick} data-testid="marksheet-file" disabled={reading} />
        </label>
        {check?.name && check.name_matches === false && (
          <div className="rounded bg-rose-600 text-white text-xs font-semibold px-2 py-1.5" data-testid="marksheet-name-warning">
            Name mismatch — marksheet: &ldquo;{check.name}&rdquo; · app: &ldquo;{check.expected_name}&rdquo;
          </div>
        )}
        {check?.name && check.name_matches && <div className="text-xs text-emerald-700" data-testid="marksheet-name-ok">Name on marksheet matches the app.</div>}
        <Field label="Exam name *">
          <input className="iu-input" value={f.exam_name} onChange={(e) => set("exam_name", e.target.value)} placeholder="e.g. SSC Class X Board Exam" data-testid="marksheet-exam" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Month *">
            <select className="iu-input" value={f.month} onChange={(e) => set("month", Number(e.target.value) || "")} data-testid="marksheet-month">
              <option value="">Pick month</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Year *">
            <input type="number" min={1980} max={nowYear + 1} className="iu-input" value={f.year} onChange={(e) => set("year", Number(e.target.value) || "")} placeholder={String(nowYear)} data-testid="marksheet-year" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Board / school"><input className="iu-input" value={f.board} onChange={(e) => set("board", e.target.value)} data-testid="marksheet-board" /></Field>
          <Field label="Overall % or grade"><input className="iu-input" value={f.result} onChange={(e) => set("result", e.target.value)} placeholder="e.g. 86% or A1" data-testid="marksheet-result" /></Field>
        </div>
        <Field label="Notes"><textarea rows={2} className="iu-input" value={f.notes} onChange={(e) => set("notes", e.target.value)} data-testid="marksheet-notes" /></Field>
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="iu-btn-secondary" data-testid="marksheet-cancel">Cancel</button>
          <button type="button" onClick={save} disabled={saving || reading || !f.exam_name || !f.month || !f.year} className="iu-btn-primary" data-testid="marksheet-save">
            {saving ? <Loader2 size={16} className="animate-spin" /> : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
