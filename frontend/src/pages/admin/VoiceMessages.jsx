import React, { useEffect, useRef, useState } from "react";
import { Loader2, Phone, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { api, apiUrl, uploadFile } from "../../api";

const TYPES = [
  { key: "late", label: "Late arrival" },
  { key: "absent", label: "Absent" },
];

function VoiceRow({ type, label, info, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [bust, setBust] = useState(Date.now());
  const fileRef = useRef(null);

  const generate = async () => {
    setBusy(true);
    try {
      await api.post(`/admin/voice-messages/${type}/generate`);
      toast.success(`Generated ${label} message (Telugu + Hindi)`);
      setBust(Date.now());
      onChanged && onChanged();
    } catch (e) { toast.error(e?.message || "Generation failed"); }
    finally { setBusy(false); }
  };

  const upload = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      await uploadFile(`/admin/voice-messages/${type}/upload`, f);
      toast.success(`Uploaded ${label} recording`);
      setBust(Date.now());
      onChanged && onChanged();
    } catch (err) { toast.error(err?.message || "Upload failed"); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid={`voice-row-${type}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-bold text-slate-800 text-sm">{label}</span>
        {info?.set
          ? <span className="text-[11px] font-semibold text-emerald-600 capitalize">{info.source} ✓</span>
          : <span className="text-[11px] text-slate-400">Not set</span>}
      </div>
      {info?.set && (
        <audio data-testid={`voice-audio-${type}`} controls src={`${apiUrl(`/voice-messages/${type}/audio`)}?t=${bust}`} className="w-full h-9 mb-2" />
      )}
      <div className="flex flex-wrap gap-2">
        <button data-testid={`voice-generate-${type}`} onClick={generate} disabled={busy} className="iu-btn-secondary !text-xs !h-8">
          {busy ? <Loader2 className="animate-spin" size={13} /> : <><Sparkles size={13} /> Generate (TE+HI)</>}
        </button>
        <button data-testid={`voice-upload-${type}`} onClick={() => fileRef.current?.click()} disabled={busy} className="iu-btn-secondary !text-xs !h-8">
          <Upload size={13} /> Upload mp3
        </button>
        <input ref={fileRef} type="file" accept="audio/mpeg,audio/mp3,.mp3" onChange={upload} className="hidden" />
      </div>
    </div>
  );
}

export default function VoiceMessages() {
  const [items, setItems] = useState(null);
  const load = async () => {
    try { setItems(await api.get("/admin/voice-messages")); }
    catch { setItems([]); }
  };
  useEffect(() => { load(); }, []);
  const infoFor = (k) => (items || []).find((i) => i.type === k);

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mt-6" data-testid="voice-messages-card">
      <div className="flex items-center gap-2 mb-1">
        <Phone size={18} className="text-violet-500" />
        <h2 className="text-lg font-extrabold">Parent voice call (Telugu + Hindi)</h2>
      </div>
      <p className="text-[12px] text-slate-500 mb-4">
        When you notify parents, a phone call also plays this recording (Telugu then Hindi). Generate an AI voice now, or upload your own recording to replace it. Needs a <b>voice-capable</b> Twilio number on the institution&apos;s sender.
      </p>
      {!items ? (
        <div className="flex justify-center py-6"><Loader2 className="animate-spin text-slate-400" /></div>
      ) : (
        <div className="space-y-3">
          {TYPES.map((t) => <VoiceRow key={t.key} type={t.key} label={t.label} info={infoFor(t.key)} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
