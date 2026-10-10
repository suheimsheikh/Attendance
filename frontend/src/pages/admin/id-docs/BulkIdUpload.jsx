import React, { useMemo, useRef, useState } from "react";
import { UploadCloud, Loader2, Save, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

const MAX_FILES = 30;
let seq = 0;
const PERSON_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const CARD_LABEL = { pan: "PAN", aadhaar: "Aadhaar", passport: "Passport", birth: "Birth certificate" };
const norm = (s) => (s || "").toUpperCase().split(/\s+/).filter(Boolean).join(" ");
const slotOf = (slots, r) => slots.find((s) => s.member_id === r.member_id && s.person === (r.person || "self"));
const appName = (slots, r) => slotOf(slots, r)?.person_name;
const DOB_KEY = { birth: "birth_dob", passport: "passport_dob", aadhaar: "aadhaar_dob", pan: "pan_dob" };
const isSelf = (r) => (r.person || "self") === "self";
const dobBad = (slots, r) => !!(r.card && r.member_id && isSelf(r) && r.dob && slotOf(slots, r)?.app_dob && r.dob !== slotOf(slots, r).app_dob);
// Strict passport rule: same words in the same order (case/spacing ignored).
const mismatch = (slots, r) => !!(r.card && r.member_id && r.cardName && appName(slots, r) && norm(r.cardName) !== norm(appName(slots, r)));

// Run `fn` over items with at most `n` in flight (keeps Gemini calls polite).
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

function RowEditor({ row, slots, onChange, onRemove, onUseName }) {
  const members = useMemo(() => [...new Map(slots.map((s) => [s.member_id, s.member_name])).entries()]
    .sort((a, b) => (a[1] || "").localeCompare(b[1] || "")), [slots]);
  const persons = slots.filter((s) => s.member_id === row.member_id && (row.card !== "birth" || s.person === "self"));
  const bad = mismatch(slots, row);
  const badDob = dobBad(slots, row);
  const tid = `bulk-row-${row.key}`;
  return (
    <tr className="border-t border-slate-100 align-top" data-testid={tid}>
      <td className="p-2 text-xs max-w-[160px] truncate" title={row.file.name}>{row.file.name}</td>
      <td className="p-2 text-xs">
        {row.status === "reading" ? <span className="inline-flex items-center gap-1 text-slate-500"><Loader2 size={12} className="animate-spin" />Reading…</span>
          : <span title="Name the AI read on the card">{row.cardName || <i className="text-slate-400">no name read</i>}</span>}
        {row.card === "passport" && row.expiry && <div className="text-slate-500 mt-0.5">expires {row.expiry}</div>}
        {row.dob && isSelf(row) && <div className="text-slate-500 mt-0.5">born {row.dob}</div>}
        {badDob && <div className="bg-rose-600 text-white rounded px-1.5 py-0.5 font-semibold mt-1" data-testid={`${tid}-dob-warning`}>
          DOB ≠ app ({slotOf(slots, row).app_dob})</div>}
        {bad && (
          <div className={`font-semibold mt-1 ${row.card === "passport" ? "text-rose-600" : "bg-rose-600 text-white rounded px-1.5 py-0.5"}`} data-testid={`${tid}-name-warning`}
            title={`App name: ${appName(slots, row)}`}>
            {row.card === "passport" ? "Not exactly the app name" : `${CARD_LABEL[row.card]} name ≠ app name`}
            {row.card === "passport" && (
              <button type="button" data-testid={`${tid}-use-name`} onClick={onUseName}
                title="Replace the member's / parent's name in the app with this passport name"
                className="block mt-0.5 px-1.5 h-5 rounded bg-rose-600 text-white text-[10px]">Use passport name</button>)}
          </div>)}
        {row.readError && <div className="text-rose-600 mt-1" data-testid={`${tid}-read-error`}>{row.readError} — fill in by hand</div>}
        {row.status === "ready" && !row.member_id && (
          <div className="text-amber-700 mt-1 inline-flex items-center gap-1" data-testid={`${tid}-nomatch`}><AlertTriangle size={11} />No match — pick below</div>)}
      </td>
      <td className="p-2">
        <select value={row.card || ""} onChange={(e) => onChange({ card: e.target.value, ...(e.target.value === "birth" ? { person: "self" } : {}) })} className="iu-input !h-8 !text-xs" data-testid={`${tid}-card`} title="Card type (detected automatically)">
          <option value="">— card —</option><option value="pan">PAN</option><option value="aadhaar">Aadhaar</option><option value="passport">Passport</option><option value="birth">Birth certificate</option>
        </select>
      </td>
      <td className="p-2">
        <input value={row.number || ""} onChange={(e) => onChange({ number: e.target.value })} className="iu-input !h-8 !text-xs font-mono uppercase w-36"
          data-testid={`${tid}-number`} title="Number read from the scan — check it's correct" placeholder="number" />
      </td>
      <td className="p-2">
        <select value={row.member_id || ""} onChange={(e) => onChange({ member_id: e.target.value, person: "self" })} className="iu-input !h-8 !text-xs max-w-[180px]"
          data-testid={`${tid}-member`} title="Which member this card belongs to (suggested from the name)">
          <option value="">— member —</option>
          {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </td>
      <td className="p-2">
        <select value={row.person || "self"} onChange={(e) => onChange({ person: e.target.value })} className="iu-input !h-8 !text-xs" disabled={!row.member_id}
          data-testid={`${tid}-person`} title="Member themselves or their father / mother / guardian">
          {persons.map((s) => <option key={s.person} value={s.person}>{PERSON_LABEL[s.person]}{s.person !== "self" && s.person_name ? ` · ${s.person_name}` : ""}</option>)}
        </select>
      </td>
      <td className="p-2 text-xs">{row.status === "saved" ? <span className="text-emerald-700 font-semibold">Saved</span>
        : row.status === "error" ? <span className="text-rose-600" title={`${row.error} — press Save all to retry`} data-testid={`${tid}-failed`}>Failed · retry</span> : null}</td>
      <td className="p-2"><button type="button" onClick={onRemove} className="p-1.5 rounded text-rose-500 hover:bg-rose-50" title="Remove this file from the batch" data-testid={`${tid}-remove`}><Trash2 size={13} /></button></td>
    </tr>
  );
}

export default function BulkIdUpload({ slots, onNamesChanged }) {
  const [rows, setRows] = useState([]);
  const [alertRows, setAlertRows] = useState(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const patch = (key, p) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const addFiles = async (fileList) => {
    const files = [...fileList].slice(0, MAX_FILES - rows.length);
    if (fileList.length > files.length) toast.warning(`Only ${MAX_FILES} files per batch — extra files skipped`);
    const fresh = files.map((file) => ({ key: `f${++seq}`, file, status: "reading" }));
    setRows((rs) => [...rs, ...fresh]);
    await pool(fresh, 3, async (r) => {
      try {
        const fd = new FormData();
        fd.append("file", r.file);
        const res = await api.post("/id-docs/bulk/read", fd);
        patch(r.key, { status: "ready", card: res.detected?.type || "", number: res.detected?.number || "",
          cardName: res.detected?.name || "", member_id: res.match?.member_id || "", person: res.match?.person || "self",
          expiry: res.detected?.expiry || "", dob: res.detected?.dob || "" });
      } catch (e) { patch(r.key, { status: "ready", readError: e.message || "Couldn't read this file" }); }
    });
  };

  // Failed rows stay eligible so "Save all" retries them; a scan already uploaded isn't re-sent.
  const ready = rows.filter((r) => (r.status === "ready" || r.status === "error") && r.member_id && r.card);
  const saveAll = async () => {
    setSaving(true);
    for (const r of ready) {
      try {
        const fd = new FormData();
        fd.append("file", r.file);
        const target = `${r.member_id}/${r.person}/${r.card}`;
        if (r.uploadedTo !== target) {
          await api.post(`/members/${r.member_id}/id-docs/${r.person}/${r.card}?ocr=false`, fd);
          r.uploadedTo = target;
          patch(r.key, { uploadedTo: target });
        }
        const nums = { [r.card]: r.number, [`${r.card}_name`]: r.cardName || "",
          ...(r.card === "passport" && r.expiry ? { passport_expiry: r.expiry } : {}),
          ...(r.dob && isSelf(r) ? { [DOB_KEY[r.card]]: r.dob } : {}) };
        if (!r.number) delete nums[r.card];
        await api.put(`/members/${r.member_id}/id-docs`, { people: { [r.person]: nums } });
        r.status = "saved";
        patch(r.key, { status: "saved" });
      } catch (e) { patch(r.key, { status: "error", error: e.message }); showApiError(e, `${r.file.name} failed`); }
    }
    setSaving(false);
    toast.success("Batch saved — check any rows marked Failed");
    const bad = ready.filter((r) => r.status === "saved" && (mismatch(slots, r) || dobBad(slots, r)));
    if (bad.length) setAlertRows(bad);
  };

  return (
    <div data-testid="bulk-id-upload">
      <div onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()} data-testid="bulk-dropzone"
        title="Drop up to 30 PAN / Aadhaar / passport / birth certificate scans (PDF or photo) — each is read and matched automatically"
        className="iu-card border-2 border-dashed border-slate-300 hover:border-emerald-400 p-8 text-center cursor-pointer">
        <UploadCloud className="mx-auto text-emerald-600" size={30} />
        <div className="font-bold mt-2">Drop scans here or click to choose</div>
        <div className="text-xs text-slate-500 mt-1">Up to {MAX_FILES} files · PAN, Aadhaar, passport or birth certificate · PDF / JPG / PNG / WEBP · front + back in one file · max 10 MB each</div>
        <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" data-testid="bulk-file-input"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {rows.length > 0 && (
        <>
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 my-3">
            Check every row — the card type, number and person were suggested by reading the scan. Fix anything wrong, then Save all.
          </p>
          <div className="iu-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <tr><th className="p-2 text-left">File</th><th className="p-2 text-left">Name on card</th><th className="p-2 text-left">Card</th>
                  <th className="p-2 text-left">Number</th><th className="p-2 text-left">Member</th><th className="p-2 text-left">Person</th><th /><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => <RowEditor key={r.key} row={r} slots={slots} onChange={(p) => patch(r.key, p)}
                  onRemove={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  onUseName={async () => {
                    try {
                      const res = await api.post(`/members/${r.member_id}/id-docs/${r.person}/${r.card}/use-name`, { name: r.cardName });
                      toast.success(`Name updated to "${res.name}"`);
                      onNamesChanged?.();
                    } catch (e) { showApiError(e, "Couldn't update the name"); }
                  }} />)}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={saveAll} disabled={saving || !ready.length} className="iu-btn-primary mt-3" data-testid="bulk-save-all"
            title="Upload each matched scan to its member and save the numbers">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save all ({ready.length})
          </button>
        </>
      )}
      {alertRows && <MismatchAlert rows={alertRows} slots={slots} onClose={() => setAlertRows(null)} />}
    </div>
  );
}

function MismatchAlert({ rows, slots, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-white w-full max-w-3xl rounded-2xl p-6 space-y-3" data-testid="bulk-mismatch-alert">
        <h2 className="text-lg font-extrabold text-rose-700 flex items-center gap-2"><AlertTriangle size={18} /> {rows.length} name / DOB mismatch{rows.length > 1 ? "es" : ""}</h2>
        <p className="text-xs text-slate-600">These cards were saved, but the name or date of birth on the card isn&apos;t exactly what the app has. The app name must follow the passport — fix passport mismatches with &ldquo;Use passport name&rdquo;; Aadhaar / PAN / birth certificate names can&apos;t be changed here.</p>
        <div className="max-h-80 overflow-y-auto border border-slate-200 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
              <tr><th className="p-2 text-left">Member</th><th className="p-2 text-left">Card</th><th className="p-2 text-left">Name on card</th><th className="p-2 text-left">App name</th>
                <th className="p-2 text-left">DOB on card</th><th className="p-2 text-left">App DOB</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100" data-testid={`bulk-mismatch-${r.key}`}>
                  <td className="p-2">{slots.find((x) => x.member_id === r.member_id)?.member_name}</td>
                  <td className="p-2 font-semibold">{CARD_LABEL[r.card]}{r.person !== "self" && ` · ${PERSON_LABEL[r.person]}`}</td>
                  <td className={`p-2 ${mismatch(slots, r) ? "text-rose-700 font-semibold" : ""}`}>{r.cardName}</td>
                  <td className="p-2">{appName(slots, r)}</td>
                  <td className={`p-2 ${dobBad(slots, r) ? "text-rose-700 font-semibold" : ""}`}>{isSelf(r) ? r.dob || "—" : "n/a"}</td>
                  <td className="p-2">{isSelf(r) ? slotOf(slots, r)?.app_dob || "—" : "n/a"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end"><button type="button" onClick={onClose} className="iu-btn-primary" data-testid="bulk-mismatch-close">OK</button></div>
      </div>
    </div>
  );
}
