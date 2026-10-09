import React, { useEffect, useRef, useState } from "react";
import { FileUp, Eye, Trash2, Loader2, IdCard } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

const PEOPLE_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const CARD_LABEL = { pan: "PAN", aadhaar: "Aadhaar" };
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

// One card (PAN or Aadhaar) for one person: number + single scan.
function IdCardField({ memberId, person, card, value, file, onChange, onDoc }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const base = `/members/${memberId}/id-docs/${person}/${card}`;
  const tid = `id-${person}-${card}`;

  const upload = async (f) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast.error("File must be 10 MB or smaller"); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      onDoc(await api.post(base, fd));
      toast.success(`${CARD_LABEL[card]} scan uploaded`);
    } catch (err) { showApiError(err, "Upload failed"); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  const view = async () => {
    const tab = window.open("", "_blank");
    try {
      const blob = await api.getBlob(`${base}/file`);
      tab.location.href = URL.createObjectURL(blob);
    } catch (err) { tab?.close(); showApiError(err, "Could not open scan"); }
  };

  const remove = async () => {
    if (!window.confirm(`Remove the ${CARD_LABEL[card]} scan?`)) return;
    try { onDoc(await api.del(`${base}/file`)); toast.success("Scan removed"); }
    catch (err) { showApiError(err, "Remove failed"); }
  };

  return (
    <div>
      <label className="iu-label">{CARD_LABEL[card]} number</label>
      <input data-testid={`${tid}-number`} value={value || ""} onChange={(e) => onChange(e.target.value)}
        className="iu-input font-mono text-xs uppercase" placeholder={card === "pan" ? "ABCDE1234F" : "1234 5678 9012"} />
      <div className="flex items-center gap-1.5 mt-1.5 text-[11px]">
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" data-testid={`${tid}-file-input`}
          onChange={(e) => upload(e.target.files?.[0])} />
        <button type="button" data-testid={`${tid}-upload`} onClick={() => inputRef.current?.click()} disabled={busy}
          className="inline-flex items-center gap-1 px-2 h-7 rounded-md border border-slate-200 hover:bg-slate-50 font-semibold">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />} {file ? "Replace" : "Upload scan"}
        </button>
        {file && (
          <>
            <button type="button" data-testid={`${tid}-view`} onClick={view} title={file.name}
              className="inline-flex items-center gap-1 px-2 h-7 rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 font-semibold max-w-[140px]">
              <Eye size={12} /> <span className="truncate">{file.name}</span>
            </button>
            <button type="button" data-testid={`${tid}-remove`} onClick={remove} title="Remove scan"
              className="p-1.5 rounded-md text-rose-500 hover:bg-rose-50"><Trash2 size={12} /></button>
          </>
        )}
      </div>
    </div>
  );
}

export default function IdDocsSection({ memberId }) {
  const [doc, setDoc] = useState(null);
  const [nums, setNums] = useState({});
  const [saving, setSaving] = useState(false);

  const applyDoc = (d) => {
    setDoc(d);
    setNums(Object.fromEntries((d.allowed_people || []).map((p) => {
      const x = d.people?.[p] || {};
      return [p, { pan: x.pan || "", aadhaar: x.aadhaar || "" }];
    })));
  };
  useEffect(() => { api.get(`/members/${memberId}/id-docs`).then(applyDoc).catch(() => {}); }, [memberId]);

  const setNum = (p, card, v) => setNums((n) => ({ ...n, [p]: { ...n[p], [card]: v } }));
  const save = async () => {
    setSaving(true);
    try { applyDoc(await api.put(`/members/${memberId}/id-docs`, { people: nums })); toast.success("ID numbers saved"); }
    catch (err) { showApiError(err, "Could not save ID numbers"); }
    finally { setSaving(false); }
  };

  if (!doc) return null;
  return (
    <div className="pt-3 mt-3 border-t border-slate-100" data-testid="id-docs-section">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1.5">
        <IdCard size={13} /> PAN &amp; Aadhaar (admins only)
      </div>
      <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3" data-testid="id-docs-tip">
        One file per card. Scan the <b>front and back together into one clear PDF</b> (or a photo) — max 10 MB.
      </p>
      <div className="space-y-4">
        {doc.allowed_people.map((p) => (
          <div key={p} data-testid={`id-person-${p}`}>
            <div className="text-xs font-bold text-slate-700 mb-1.5">{PEOPLE_LABEL[p]}</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {["pan", "aadhaar"].map((card) => (
                <IdCardField key={card} memberId={memberId} person={p} card={card}
                  value={nums[p]?.[card]} file={doc.people?.[p]?.[`${card}_file`]}
                  onChange={(v) => setNum(p, card, v)} onDoc={applyDoc} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <button type="button" data-testid="id-docs-save" onClick={save} disabled={saving} className="iu-btn-secondary mt-3">
        {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save ID numbers
      </button>
    </div>
  );
}
