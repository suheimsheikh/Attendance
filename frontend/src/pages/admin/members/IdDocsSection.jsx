import React, { useEffect, useRef, useState } from "react";
import { FileUp, Eye, Trash2, Loader2, IdCard, Lock, CheckCircle2, AlertTriangle, Users } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

const PEOPLE_LABEL = { self: "Member", father: "Father", mother: "Mother", guardian: "Guardian" };
const CARD_LABEL = { pan: "PAN", aadhaar: "Aadhaar", passport: "Passport", birth: "Birth certificate" };
const FAMILY_CARDS = ["aadhaar", "pan", "passport"];
const PLACEHOLDER = { pan: "ABCDE1234F", aadhaar: "1234 5678 9012", passport: "Z1234567", birth: "Registration no." };
const DOB_KEY = { birth: "birth_dob", passport: "passport_dob", aadhaar: "aadhaar_dob", pan: "pan_dob" };
const DOB_PRIORITY = ["birth", "passport", "aadhaar", "pan"];
const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const norm = (s) => (s || "").toUpperCase().split(/\s+/).filter(Boolean).join(" ");

// Ordered capture chain for the MEMBER's own documents. PAN is optional, so
// the Passport unlocks once the Aadhaar scan is in.
const STAGES = [
  { card: "birth",    step: 1, dep: null,      optional: false },
  { card: "aadhaar",  step: 2, dep: "birth",   optional: false },
  { card: "pan",      step: 3, dep: "aadhaar", optional: true },
  { card: "passport", step: 4, dep: "aadhaar", optional: false },
];

// Plain-English rule hints shown under a mismatch so the admin knows what to fix.
const HINT = {
  name: "The app name follows the Passport only. If this differs, check the spelling — you can update the app name from the Passport stage.",
  dob: "Date-of-birth priority is Birth certificate › Passport › Aadhaar › PAN. Fix the app DOB or re-scan the clearer document.",
  father: "Father's name must match across the app and every document. Correct whichever is wrong.",
  mother: "Mother's name must match across the app and every document. Correct whichever is wrong.",
};

function MatchRow({ ok, label, cardVal, appVal, hint, tid }) {
  if (ok !== false) return null;
  return (
    <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800" data-testid={tid}>
      <div className="font-semibold flex items-center gap-1.5">
        <AlertTriangle size={13} className="shrink-0" /> {label} doesn&apos;t match
      </div>
      <div className="mt-0.5 font-mono text-[11px]">on scan: &ldquo;{cardVal || "—"}&rdquo; · in app: &ldquo;{appVal || "—"}&rdquo;</div>
      <div className="mt-0.5 text-[11px] text-rose-700/90">{hint}</div>
    </div>
  );
}

// Verification panel shown after a scan is read. Confirm the number, resolve
// any name / DOB / parent mismatches. Uploads are allowed WITH mismatches —
// they just stay flagged red until sorted out.
function DetectedPanel({ card, d, onConfirm, onUseScanned, onDismiss, onUseName, onUseDob, tid }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-xs text-amber-900 space-y-2.5" data-testid={`${tid}-detected`}>
      {d.mode === "choose" ? (
        <>
          <div>The box has <b className="font-mono">{d.current}</b> but the scan shows <b className="font-mono">{d.number}</b>.</div>
          <div className="flex gap-2">
            <button type="button" data-testid={`${tid}-use-scanned`} onClick={onUseScanned} className="px-3 h-8 rounded-md bg-amber-600 text-white font-semibold">Use scanned</button>
            <button type="button" data-testid={`${tid}-keep-current`} onClick={onDismiss} className="px-3 h-8 rounded-md border border-amber-400 font-semibold">Keep current</button>
          </div>
        </>
      ) : (
        <>
          <div>Read from the {CARD_LABEL[card]} scan: number <b className="font-mono">{d.number}</b>
            {d.expiry && <> · expires <b>{d.expiry}</b></>}{d.dob && <> · born <b>{d.dob}</b></>}. Confirm it&apos;s correct.</div>
          <div className="flex gap-2">
            <button type="button" data-testid={`${tid}-confirm`} onClick={onConfirm} className="px-3 h-8 rounded-md bg-emerald-600 text-white font-semibold">Confirm &amp; save</button>
            <button type="button" data-testid={`${tid}-edit`} onClick={onDismiss} className="px-3 h-8 rounded-md border border-amber-400 font-semibold">Edit manually</button>
          </div>
        </>
      )}

      {/* Name — passport can push its name to the app; other cards are read-only vs the app name. */}
      {d.name_matches === false && (card === "passport" ? (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-rose-800" data-testid={`${tid}-name-warning`}>
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle size={13} /> Name doesn&apos;t match</div>
          <div className="mt-0.5 font-mono text-[11px]">passport: &ldquo;{d.name}&rdquo; · app: &ldquo;{d.expected_name}&rdquo;</div>
          <button type="button" onClick={onUseName} data-testid={`${tid}-use-name`}
            className="mt-1.5 px-3 h-7 rounded-md bg-rose-600 text-white font-semibold">Use passport name in app</button>
        </div>
      ) : (
        <div className="rounded-md bg-rose-50 border border-rose-200 px-3 py-2 text-rose-800" data-testid={`${tid}-name-warning`}>
          <div className="font-semibold flex items-center gap-1.5"><AlertTriangle size={13} /> Name doesn&apos;t match</div>
          <div className="mt-0.5 font-mono text-[11px]">{CARD_LABEL[card]}: &ldquo;{d.name}&rdquo; · app: &ldquo;{d.expected_name}&rdquo;</div>
          <div className="mt-0.5 text-[11px]">{HINT.name}</div>
        </div>
      ))}

      {d.dob_matches === false && (
        <MatchRow ok={false} label="Date of birth" cardVal={d.dob} appVal={d.expected_dob} hint={HINT.dob} tid={`${tid}-dob-warning`} />
      )}
      <MatchRow ok={d.father_matches} label="Father's name" cardVal={d.father_name} appVal={d.expected_father_name} hint={HINT.father} tid={`${tid}-father-warning`} />
      <MatchRow ok={d.mother_matches} label="Mother's name" cardVal={d.mother_name} appVal={d.expected_mother_name} hint={HINT.mother} tid={`${tid}-mother-warning`} />

      {d.dob_can_apply && (
        <div className="text-slate-800 flex items-center flex-wrap gap-1.5" data-testid={`${tid}-dob-diff`}>
          App has no date of birth — {CARD_LABEL[card]} shows <b>{d.dob}</b>
          <button type="button" onClick={onUseDob} data-testid={`${tid}-use-dob`}
            className="px-3 h-7 rounded-md bg-sky-600 text-white font-semibold">Use this date of birth</button>
        </div>
      )}
    </div>
  );
}

// A single card: number + optional extra date + scan upload/view/remove.
function IdCardField({ memberId, person, card, value, file, onChange, onDoc, onUploaded, extra, onExtra, cardName, appName, cardDob, wantDob, locked, onRemoveWarn, compact }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const base = `/members/${memberId}/id-docs/${person}/${card}`;
  const tid = `id-${person}-${card}`;

  const upload = async (f) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast.error("File must be 10 MB or smaller"); return; }
    setBusy(true);
    try { const fd = new FormData(); fd.append("file", f); onUploaded(await api.post(base, fd)); }
    catch (err) { showApiError(err, "Upload failed"); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const view = async () => {
    const tab = window.open("", "_blank");
    try { const blob = await api.getBlob(`${base}/file`); const url = URL.createObjectURL(blob); tab.location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60_000); }
    catch (err) { tab?.close(); showApiError(err, "Could not open scan"); }
  };
  const remove = async () => {
    const warn = onRemoveWarn?.();
    const msg = warn ? `${warn}\n\nRemove the ${CARD_LABEL[card]} scan anyway?` : `Remove the ${CARD_LABEL[card]} scan?`;
    if (!window.confirm(msg)) return;
    try { onDoc(await api.del(`${base}/file`)); toast.success("Scan removed"); }
    catch (err) { showApiError(err, "Remove failed"); }
  };

  return (
    <div>
      <label className="iu-label">{CARD_LABEL[card]} number {compact && <span className="text-slate-400 font-normal normal-case">({PEOPLE_LABEL[person]})</span>}</label>
      <input data-testid={`${tid}-number`} value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={locked}
        className="iu-input font-mono text-xs uppercase disabled:opacity-50" placeholder={PLACEHOLDER[card]} />
      {(card === "passport" || card === "birth") && (
        <div className="mt-2">
          <label className="iu-label">{card === "passport" ? "Passport expiry" : "Date of birth (on certificate)"}</label>
          <input type="date" data-testid={`${tid}-${card === "passport" ? "expiry" : "dob"}`} value={extra || ""} onChange={(e) => onExtra(e.target.value)} disabled={locked} className="iu-input text-xs disabled:opacity-50" />
        </div>
      )}
      {cardName && (
        <div data-testid={`${tid}-card-name`} className={`mt-1.5 text-[11px] ${norm(cardName) === norm(appName) ? "text-emerald-700" : "text-rose-700 font-semibold"}`}>
          Name on card: {cardName}{norm(cardName) !== norm(appName) && " — doesn't match app name"}
        </div>
      )}
      {cardDob && wantDob && (
        <div data-testid={`${tid}-card-dob`} className={`mt-0.5 text-[11px] ${cardDob === wantDob ? "text-emerald-700" : "text-rose-700 font-semibold"}`}>
          DOB on card: {cardDob}{cardDob !== wantDob && ` — doesn't match ${wantDob}`}
        </div>
      )}
      <div className="flex items-center gap-2 mt-2 text-[11px]">
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" data-testid={`${tid}-file-input`} onChange={(e) => upload(e.target.files?.[0])} />
        <button type="button" data-testid={`${tid}-upload`} onClick={() => inputRef.current?.click()} disabled={busy || locked}
          className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-slate-200 hover:bg-slate-50 font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />} {file ? "Replace scan" : "Upload scan"}
        </button>
        {file && (
          <>
            <button type="button" data-testid={`${tid}-view`} onClick={view} title={file.name}
              className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md border border-emerald-200 text-emerald-700 hover:bg-emerald-50 font-semibold max-w-[180px]">
              <Eye size={13} /> <span className="truncate">{file.name}</span>
            </button>
            <button type="button" data-testid={`${tid}-remove`} onClick={remove} title="Remove scan" className="p-2 rounded-md text-rose-500 hover:bg-rose-50"><Trash2 size={13} /></button>
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
  const [detected, setDetected] = useState({});

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
  const hasFile = (card) => !!selfDocs[`${card}_file`];
  const unlocked = (stage) => !stage.dep || hasFile(stage.dep);
  const chainBroken = STAGES.some((s) => !s.optional && hasFile(s.card) && s.dep && !hasFile(s.dep));
  const unresolved = Object.entries(detected).filter(([k, d]) =>
    k.startsWith("self.") && (d.name_matches === false || d.dob_matches === false || d.father_matches === false || d.mother_matches === false)).length;

  const renderCard = (p, card, opts = {}) => (
    <>
      <IdCardField memberId={memberId} person={p} card={card}
        value={nums[p]?.[card]} file={doc.people?.[p]?.[`${card}_file`]}
        onChange={(v) => setNum(p, card, v)} onDoc={applyDoc}
        extra={nums[p]?.[card === "birth" ? "birth_dob" : "passport_expiry"]}
        onExtra={(v) => setNum(p, card === "birth" ? "birth_dob" : "passport_expiry", v)}
        cardName={doc.people?.[p]?.[`${card}_name`]} appName={doc.app_names?.[p]}
        cardDob={p === "self" ? doc.people?.self?.[DOB_KEY[card]] : ""} wantDob={p === "self" ? wantDob : ""}
        onUploaded={(res) => onUploaded(p, card, res)} {...opts} />
      {detected[`${p}.${card}`] && (
        <DetectedPanel card={card} d={detected[`${p}.${card}`]} tid={`id-${p}-${card}`}
          onConfirm={() => confirm(p, card, detected[`${p}.${card}`].number)}
          onUseScanned={() => { setNum(p, card, detected[`${p}.${card}`].number); setDetected((x) => ({ ...x, [`${p}.${card}`]: { ...x[`${p}.${card}`], mode: "confirm" } })); }}
          onDismiss={() => clearDetected(`${p}.${card}`)} onUseName={() => applyPassportName(p, card)} onUseDob={() => applyDob(p, card)} />
      )}
    </>
  );

  return (
    <div className="pt-4 mt-4 border-t border-slate-100" data-testid="id-docs-section">
      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
        <IdCard size={13} /> Identity documents (admins only)
      </div>
      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 mb-4" data-testid="id-docs-tip">
        Upload one clear PDF/photo per card (front &amp; back together, max 10 MB). The number, name, DOB and parents&apos; names are read
        automatically and checked against the app. Capture them in order — <b>Birth certificate → Aadhaar → PAN → Passport</b>.
        You can still upload with mismatches; they stay flagged red until sorted out.
      </p>

      {(chainBroken || unresolved > 0) && (
        <div className="mb-4 rounded-md bg-rose-50 border border-rose-300 px-3 py-2 text-xs text-rose-800 font-semibold flex items-start gap-2" data-testid="id-docs-alert">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <div>
            {chainBroken && <div>A required earlier document is missing — the capture chain is broken. Re-upload it to keep the order intact.</div>}
            {unresolved > 0 && <div>{unresolved} unresolved mismatch{unresolved === 1 ? "" : "es"} on the member&apos;s documents — resolve the red items below.</div>}
          </div>
        </div>
      )}

      {/* MEMBER — staged chain */}
      <div className="text-xs font-bold text-slate-700 mb-2 flex items-center gap-1.5"><IdCard size={13} /> Member documents</div>
      <div className="space-y-3" data-testid="id-person-self">
        {STAGES.map((stage) => {
          const open = unlocked(stage);
          const done = hasFile(stage.card);
          const removeWarn = () => {
            const dependents = STAGES.filter((s) => s.dep === stage.card && hasFile(s.card)).map((s) => CARD_LABEL[s.card]);
            return dependents.length ? `This will break the capture chain — ${dependents.join(", ")} ${dependents.length === 1 ? "was" : "were"} added after it.` : "";
          };
          return (
            <div key={stage.card} className={`rounded-xl border p-4 ${done ? "border-emerald-200 bg-emerald-50/30" : open ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"}`} data-testid={`stage-${stage.card}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${done ? "bg-emerald-600 text-white" : open ? "bg-sky-600 text-white" : "bg-slate-300 text-white"}`}>
                  {done ? <CheckCircle2 size={15} /> : !open ? <Lock size={13} /> : stage.step}
                </span>
                <span className="font-bold text-sm text-slate-800">{CARD_LABEL[stage.card]}</span>
                {stage.optional && <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">optional</span>}
                {done && <span className="ml-auto text-[11px] font-semibold text-emerald-700">Uploaded</span>}
              </div>
              {open ? renderCard("self", stage.card, { locked: false, onRemoveWarn: removeWarn })
                : <div className="text-xs text-slate-500 flex items-center gap-1.5 pl-1" data-testid={`stage-${stage.card}-locked`}>
                    <Lock size={12} /> Upload the {CARD_LABEL[stage.dep]} scan first to unlock this stage.
                  </div>}
            </div>
          );
        })}
      </div>

      {/* FAMILY — always open */}
      {doc.allowed_people.filter((p) => p !== "self").length > 0 && (
        <>
          <div className="text-xs font-bold text-slate-700 mt-5 mb-2 flex items-center gap-1.5"><Users size={13} /> Family IDs</div>
          <div className="space-y-4">
            {doc.allowed_people.filter((p) => p !== "self").map((p) => (
              <div key={p} data-testid={`id-person-${p}`} className="rounded-xl border border-slate-200 p-4">
                <div className="text-xs font-bold text-slate-700 mb-2">{PEOPLE_LABEL[p]}</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {FAMILY_CARDS.map((card) => <div key={card}>{renderCard(p, card, { compact: true })}</div>)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <button type="button" data-testid="id-docs-save" onClick={() => save()} disabled={saving} className="iu-btn-secondary mt-4">
        {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save ID numbers
      </button>
    </div>
  );
}
