import React, { useEffect, useRef, useState } from "react";
import { FileUp, Eye, Trash2, Loader2, IdCard } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

const PEOPLE_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const CARD_LABEL = { pan: "PAN", aadhaar: "Aadhaar", passport: "Passport", birth: "Birth certificate" };
const CARDS = ["pan", "aadhaar", "passport"];
const cardsFor = (p) => (p === "self" ? [...CARDS, "birth"] : CARDS);
const PLACEHOLDER = { pan: "ABCDE1234F", aadhaar: "1234 5678 9012", passport: "Z1234567", birth: "Registration no." };
const DOB_KEY = { birth: "birth_dob", passport: "passport_dob", aadhaar: "aadhaar_dob", pan: "pan_dob" };
const DOB_PRIORITY = ["birth", "passport", "aadhaar", "pan"];
const norm = (s) => (s || "").toUpperCase().split(/\s+/).filter(Boolean).join(" ");
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

// Shown after a scan is read: confirm the auto-filled number, or pick between
// the typed one and the scanned one. Name mismatch is a warning only.
function DetectedBar({ card, d, onConfirm, onUseScanned, onDismiss, onUseName, onUseDob, tid }) {
  return (
    <div className="mt-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 space-y-1" data-testid={`${tid}-detected`}>
      {d.mode === "choose" ? (
        <>
          <div>Box has <b className="font-mono">{d.current}</b> but the scan shows <b className="font-mono">{d.number}</b>.</div>
          <div className="flex gap-1.5">
            <button type="button" data-testid={`${tid}-use-scanned`} onClick={onUseScanned} className="px-2 h-6 rounded bg-amber-600 text-white font-semibold">Use scanned</button>
            <button type="button" data-testid={`${tid}-keep-current`} onClick={onDismiss} className="px-2 h-6 rounded border border-amber-400 font-semibold">Keep current</button>
          </div>
        </>
      ) : (
        <>
          <div>Detected {CARD_LABEL[card]} from scan: <b className="font-mono">{d.number}</b>
            {d.expiry && <> · expires <b>{d.expiry}</b></>}{d.dob && <> · born <b>{d.dob}</b></>}. Please check it&apos;s correct.</div>
          <div className="flex gap-1.5">
            <button type="button" data-testid={`${tid}-confirm`} onClick={onConfirm} className="px-2 h-6 rounded bg-emerald-600 text-white font-semibold">Confirm &amp; save</button>
            <button title="Edit this item" type="button" data-testid={`${tid}-edit`} onClick={onDismiss} className="px-2 h-6 rounded border border-amber-400 font-semibold">Edit</button>
          </div>
        </>
      )}
      {d.name_matches === false && (card === "passport" ? (
        <div className="text-rose-700 font-semibold" data-testid={`${tid}-name-warning`}>
          Name is NOT exactly the same — passport: &ldquo;{d.name}&rdquo; · app: &ldquo;{d.expected_name}&rdquo;.
          <button type="button" onClick={onUseName} data-testid={`${tid}-use-name`}
            title="Replace the name in the app with the passport name (normal capitals)"
            className="ml-1.5 px-2 h-6 rounded bg-rose-600 text-white font-semibold">Use passport name</button>
        </div>
      ) : (
        <div className="rounded bg-rose-600 text-white font-semibold px-2 py-1" data-testid={`${tid}-name-warning`}>
          Name mismatch — {CARD_LABEL[card]}: &ldquo;{d.name}&rdquo; · app: &ldquo;{d.expected_name}&rdquo;.
          <span className="font-normal"> The {CARD_LABEL[card]} name can&apos;t be changed here — the app name follows the passport only.</span>
        </div>
      ))}
      {d.dob_matches === false && (
        <div className="rounded bg-rose-600 text-white font-semibold px-2 py-1" data-testid={`${tid}-dob-warning`}>
          DOB mismatch — {CARD_LABEL[card]}: {d.dob} · app: {d.expected_dob}.
        </div>
      )}
      {d.dob_can_apply && (
        <div className="text-slate-800" data-testid={`${tid}-dob-diff`}>
          App has no date of birth — {CARD_LABEL[card]} shows <b>{d.dob}</b>
          <button type="button" onClick={onUseDob} data-testid={`${tid}-use-dob`} title="Set the member's date of birth in the app from this card"
            className="ml-1.5 px-2 h-6 rounded bg-sky-600 text-white font-semibold">Use this date of birth</button>
        </div>
      )}
    </div>
  );
}

// One card (PAN or Aadhaar) for one person: number + single scan.
function IdCardField({ memberId, person, card, value, file, onChange, onDoc, onUploaded, extra, onExtra, cardName, appName, cardDob, wantDob }) {
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
      onUploaded(await api.post(base, fd));
    } catch (err) { showApiError(err, "Upload failed"); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  const view = async () => {
    const tab = window.open("", "_blank");
    try {
      const blob = await api.getBlob(`${base}/file`);
      const url = URL.createObjectURL(blob);
      tab.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
        className="iu-input font-mono text-xs uppercase" placeholder={PLACEHOLDER[card]} />
      {(card === "passport" || card === "birth") && (
        <div className="mt-1.5">
          <label className="iu-label">{card === "passport" ? "Passport expiry" : "Date of birth (on certificate)"}</label>
          <input type="date" data-testid={`${tid}-${card === "passport" ? "expiry" : "dob"}`} value={extra || ""} onChange={(e) => onExtra(e.target.value)} className="iu-input text-xs" />
        </div>
      )}
      {cardName && (
        <div data-testid={`${tid}-card-name`} title="Name read from the scan"
          className={`mt-1 text-[11px] ${norm(cardName) === norm(appName) ? "text-emerald-700" : "text-rose-700 font-semibold"}`}>
          Name on card: {cardName}{norm(cardName) !== norm(appName) && " — doesn't match app name"}
        </div>
      )}
      {cardDob && wantDob && (
        <div data-testid={`${tid}-card-dob`} title="Date of birth read from the scan vs the app (or the first ID on file)"
          className={`mt-0.5 text-[11px] ${cardDob === wantDob ? "text-emerald-700" : "text-rose-700 font-semibold"}`}>
          DOB on card: {cardDob}{cardDob !== wantDob && ` — doesn't match ${wantDob}`}
        </div>
      )}
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

export default function IdDocsSection({ memberId, onNameChanged }) {
  const [doc, setDoc] = useState(null);
  const [nums, setNums] = useState({});
  const [saving, setSaving] = useState(false);
  const [detected, setDetected] = useState({});   // { "self.pan": {mode, number, current, name, ...} }

  const applyDoc = (d) => {
    setDoc(d);
    setNums(Object.fromEntries((d.allowed_people || []).map((p) => {
      const x = d.people?.[p] || {};
      return [p, { pan: x.pan || "", aadhaar: x.aadhaar || "", passport: x.passport || "", passport_expiry: x.passport_expiry || "",
        ...(p === "self" ? { birth: x.birth || "", birth_dob: x.birth_dob || "" } : {}) }];
    })));
  };
  useEffect(() => { api.get(`/members/${memberId}/id-docs`).then(applyDoc).catch(() => {}); }, [memberId]);

  const setNum = (p, card, v) => setNums((n) => ({ ...n, [p]: { ...n[p], [card]: v } }));
  const clearDetected = (k) => setDetected(({ [k]: _drop, ...rest }) => rest);
  const save = async (people = nums) => {
    setSaving(true);
    try { applyDoc(await api.put(`/members/${memberId}/id-docs`, { people })); toast.success("ID numbers saved"); return true; }
    catch (err) { showApiError(err, "Could not save ID numbers"); return false; }
    finally { setSaving(false); }
  };
  // Keep unsaved typing: only the file metadata comes from the upload response.
  const onUploaded = (p, card, res) => {
    setDoc(res);
    const d = res.detected;
    if (!d?.number) { toast.message(`${CARD_LABEL[card]} scan uploaded — couldn't read the number, please type it`); return; }
    toast.success(`${CARD_LABEL[card]} scan uploaded — number detected`);
    const current = (nums[p]?.[card] || "").replace(/\s/g, "").toUpperCase();
    const k = `${p}.${card}`;
    if (current && current !== d.number) { setDetected((x) => ({ ...x, [k]: { ...d, mode: "choose", current } })); return; }
    setNum(p, card, d.number);
    if (card === "passport" && d.expiry) setNum(p, "passport_expiry", d.expiry);
    if (card === "birth" && d.dob) setNum(p, "birth_dob", d.dob);
    setDetected((x) => ({ ...x, [k]: { ...d, mode: "confirm" } }));
  };
  const applyPassportName = async (p, card) => {
    const k = `${p}.${card}`;
    try {
      const res = await api.post(`/members/${memberId}/id-docs/${p}/passport/use-name`, { name: detected[k].name });
      onNameChanged?.(res.field, res.name);
      setDoc((x) => ({ ...x, app_names: { ...x.app_names, [p]: res.name } }));
      setDetected((x) => ({ ...x, [k]: { ...x[k], name_matches: true, expected_name: res.name } }));
      toast.success(`Name updated to "${res.name}"`);
    } catch (err) { showApiError(err, "Couldn't update the name"); }
  };
  const applyDob = async (p, card) => {
    const k = `${p}.${card}`;
    try {
      const res = await api.post(`/members/${memberId}/id-docs/self/${card}/use-dob`, { dob: detected[k].dob });
      onNameChanged?.(res.field, res.dob);
      setDoc((x) => ({ ...x, app_dob: res.dob }));
      setDetected((x) => ({ ...x, [k]: { ...x[k], expected_dob: res.dob, dob_can_apply: false, dob_matches: true } }));
      toast.success(`Date of birth set to ${res.dob}`);
    } catch (err) { showApiError(err, "Couldn't update the date of birth"); }
  };
  const confirm = async (p, card, number) => {
    const d = detected[`${p}.${card}`] || {};
    const extra = card === "passport" && d.expiry ? { passport_expiry: d.expiry } : card === "birth" && d.dob ? { birth_dob: d.dob } : {};
    const people = { ...nums, [p]: { ...nums[p], [card]: number, ...extra } };
    if (await save(people)) clearDetected(`${p}.${card}`);
  };

  if (!doc) return null;
  const selfDocs = doc.people?.self || {};
  const refDob = DOB_PRIORITY.map((c) => selfDocs[DOB_KEY[c]]).find(Boolean) || "";
  const wantDob = doc.app_dob || refDob;
  return (
    <div className="pt-3 mt-3 border-t border-slate-100" data-testid="id-docs-section">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1 flex items-center gap-1.5">
        <IdCard size={13} /> PAN, Aadhaar, Passport &amp; Birth certificate (admins only)
      </div>
      <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mb-3" data-testid="id-docs-tip">
        One file per card. Scan the <b>front and back together into one clear PDF</b> (or a photo) — max 10 MB.
        The number is read from the scan automatically — just confirm it.
      </p>
      <div className="space-y-4">
        {doc.allowed_people.map((p) => (
          <div key={p} data-testid={`id-person-${p}`}>
            <div className="text-xs font-bold text-slate-700 mb-1.5">{PEOPLE_LABEL[p]}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {cardsFor(p).map((card) => (
                <div key={card}>
                  <IdCardField memberId={memberId} person={p} card={card}
                    value={nums[p]?.[card]} file={doc.people?.[p]?.[`${card}_file`]}
                    onChange={(v) => setNum(p, card, v)} onDoc={applyDoc}
                    extra={nums[p]?.[card === "birth" ? "birth_dob" : "passport_expiry"]}
                    onExtra={(v) => setNum(p, card === "birth" ? "birth_dob" : "passport_expiry", v)}
                    cardName={doc.people?.[p]?.[`${card}_name`]} appName={doc.app_names?.[p]}
                    cardDob={p === "self" ? doc.people?.self?.[DOB_KEY[card]] : ""} wantDob={p === "self" ? wantDob : ""}
                    onUploaded={(res) => onUploaded(p, card, res)} />
                  {detected[`${p}.${card}`] && (
                    <DetectedBar card={card} d={detected[`${p}.${card}`]} tid={`id-${p}-${card}`}
                      onConfirm={() => confirm(p, card, detected[`${p}.${card}`].number)}
                      onUseScanned={() => {
                        setNum(p, card, detected[`${p}.${card}`].number);
                        setDetected((x) => ({ ...x, [`${p}.${card}`]: { ...x[`${p}.${card}`], mode: "confirm" } }));
                      }}
                      onDismiss={() => clearDetected(`${p}.${card}`)} onUseName={() => applyPassportName(p, card)} onUseDob={() => applyDob(p, card)} />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <button type="button" data-testid="id-docs-save" onClick={() => save()} disabled={saving} className="iu-btn-secondary mt-3">
        {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save ID numbers
      </button>
    </div>
  );
}
