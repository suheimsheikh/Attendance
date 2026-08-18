import React, { useEffect, useState } from "react";
import { Loader2, Trash2, Camera, AlertTriangle, ImageOff, CheckSquare, Square } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { formatDate } from "../../utils";

/**
 * EscortPhotoCleanup — admin curation page for escort selfies older than
 * the 30-day retention window. Per the Jun-27 product decision (6c):
 *   - Photos are NOT auto-deleted.
 *   - This page lists "PURGE READY" rows (badge per the spec).
 *   - Admin picks which rows to clean and clicks Delete photos.
 *
 * The page only manages SELFIE blobs — attendance rows stay so the
 * audit trail (who was on campus when, with which athletes) survives.
 */
export default function EscortPhotoCleanup() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [previewId, setPreviewId] = useState(null);
  const [preview, setPreview] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setRows(await api.get("/escort-attendance/photos/purge-candidates"));
    } catch (err) { toast.error(err?.message || "Could not load"); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const purgeOne = async (att_id) => {
    if (!window.confirm("Delete this row's selfies? This cannot be undone.")) return;
    setBusy(true);
    try {
      await api.del(`/escort-attendance/${att_id}/photos`);
      toast.success("Photos deleted");
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  const purgeBulk = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Delete photos on ${selected.size} row${selected.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await api.post("/escort-attendance/photos/purge-bulk", { att_ids: [...selected] });
      toast.success(`Purged ${r.purged} row${r.purged === 1 ? "" : "s"}`);
      setSelected(new Set());
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusy(false); }
  };

  const openPreview = async (id) => {
    setPreviewId(id);
    try { setPreview(await api.get(`/escort-attendance/${id}`)); }
    catch (err) { toast.error(err?.message || "Could not load"); setPreviewId(null); }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Escort Photo Cleanup</h1>
        <p className="text-slate-500 text-sm mt-1">
          Selfies attached to escort check-ins / check-outs are flagged <strong className="text-amber-700">PURGE READY</strong> after 30 days.
          You decide what to keep. Attendance rows themselves stay either way — only the photo blobs are removed.
        </p>
      </header>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="cleanup-empty">
          <ImageOff size={36} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold">Nothing to clean</p>
          <p className="text-sm text-slate-500 mt-1">No escort selfies are past the 30-day retention window.</p>
        </div>
      ) : (
        <>
          <div className="iu-card p-3 mb-3 flex items-center gap-3 sticky top-0 z-10" data-testid="cleanup-toolbar">
            <button onClick={toggleAll} className="text-slate-500 hover:text-slate-800" data-testid="cleanup-toggle-all" title="Select or unselect every photo shown">
              {selected.size === rows.length && rows.length > 0
                ? <CheckSquare size={18} className="text-emerald-600"/>
                : <Square size={18}/>}
            </button>
            <div className="text-xs text-slate-600 flex-1">
              {rows.length} row{rows.length === 1 ? "" : "s"} ready · {selected.size} selected
            </div>
            <button
              onClick={purgeBulk}
              disabled={busy || selected.size === 0}
              data-testid="cleanup-purge-selected"
              className="iu-btn-primary !h-9 !px-3 !text-xs !bg-red-600 hover:!bg-red-700"
            >
              {busy ? <Loader2 className="animate-spin" size={13}/> : <Trash2 size={13}/>} Delete selected
            </button>
          </div>

          <div className="iu-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="iu-table-th w-8"></th>
                  <th className="iu-table-th !text-left">Escort</th>
                  <th className="iu-table-th !text-left hidden sm:table-cell">Institution</th>
                  <th className="iu-table-th !text-left w-24">Date</th>
                  <th className="iu-table-th !text-left">Photos</th>
                  <th className="iu-table-th !text-right w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-t border-slate-100 ${selected.has(r.id) ? "bg-amber-50/40" : ""}`} data-testid={`cleanup-row-${r.id}`}>
                    <td className="iu-table-td">
                      <button onClick={() => toggle(r.id)} data-testid={`cleanup-select-${r.id}`}>
                        {selected.has(r.id)
                          ? <CheckSquare size={16} className="text-amber-600"/>
                          : <Square size={16} className="text-slate-300"/>}
                      </button>
                    </td>
                    <td className="iu-table-td font-semibold">{r.escort_name}</td>
                    <td className="iu-table-td hidden sm:table-cell text-xs text-slate-500">{r.institution}</td>
                    <td className="iu-table-td font-mono text-xs">{formatDate(r.date)}</td>
                    <td className="iu-table-td">
                      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
                        <AlertTriangle size={10}/> Purge ready
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 inline-flex items-center gap-1.5">
                        {r.has_check_in_selfie && <Camera size={11}/>}
                        {r.has_check_in_selfie ? "in" : ""}
                        {r.has_check_in_selfie && r.has_check_out_selfie ? " · " : ""}
                        {r.has_check_out_selfie ? "out" : ""}
                      </div>
                    </td>
                    <td className="iu-table-td text-right">
                      <button onClick={() => openPreview(r.id)} className="text-xs underline mr-2 text-slate-600 hover:text-slate-900" data-testid={`cleanup-preview-${r.id}`}>Preview</button>
                      <button
                        onClick={() => purgeOne(r.id)}
                        disabled={busy}
                        className="text-xs text-red-600 hover:text-red-800"
                        data-testid={`cleanup-purge-${r.id}`}
                      >Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {previewId && preview && (
        <div className="iu-modal" onClick={() => { setPreviewId(null); setPreview(null); }}>
          <div className="iu-modal-card max-w-md p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="font-bold">{preview.escort_name} · {formatDate(preview.date)}</div>
            <div className="grid grid-cols-2 gap-3">
              <PhotoTile label="Check-in" b64={preview.check_in_selfie} />
              <PhotoTile label="Check-out" b64={preview.check_out_selfie} />
            </div>
            <button onClick={() => { setPreviewId(null); setPreview(null); }} className="iu-btn-secondary w-full">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PhotoTile({ label, b64 }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1">{label}</div>
      {b64 ? (
        <img src={b64} alt={label} className="w-full aspect-square object-cover rounded-lg border border-slate-200" />
      ) : (
        <div className="w-full aspect-square rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-center text-xs text-slate-400">none</div>
      )}
    </div>
  );
}
