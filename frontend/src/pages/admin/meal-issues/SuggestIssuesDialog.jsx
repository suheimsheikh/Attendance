import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";
import { useAuth } from "../../../auth";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../../../components/ui/dialog";
import { HeadcountRow, SuggestLines } from "./SuggestParts";
import { UnmatchedList, UnitMismatchList } from "./SuggestWarnings";
import { fmtDateLong } from "../../../utils/dates";

/** Draft issue lines from the weekday's recipe menu × the day's meals muster. Nothing is saved here. */
export default function SuggestIssuesDialog({ open, onOpenChange, dateStr, onApply }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({});
  const [picked, setPicked] = useState({});
  const [mapping, setMapping] = useState(null);

  const load = useCallback(async (counts) => {
    setBusy(true);
    try {
      const r = await api.post("/meals/issues/suggest", { date: dateStr, counts: counts || null });
      setData(r);
      setPicked(Object.fromEntries(r.lines.map((l) => [l.item_id, true])));
    } catch (e) { showApiError(e, "Couldn't build suggestions"); }
    finally { setBusy(false); }
  }, [dateStr]);

  useEffect(() => { if (open) { setDraft({}); load(null); } }, [open, load]);

  const counts = () => Object.fromEntries(Object.entries(data.headcounts).map(([k, h]) => [k, Number(draft[k] ?? h.used) || 0]));

  const mapIngredient = async (from, to) => {
    setMapping(`${from}→${to}`);
    try {
      const r = await api.post("/recipes/rename-ingredient", { from_name: from, to_name: to });
      toast.success(`Mapped "${from}" → "${to}" in ${r.updated} recipe line${r.updated === 1 ? "" : "s"}`);
      await load(counts());
    } catch (e) { showApiError(e, "Couldn't map ingredient"); }
    finally { setMapping(null); }
  };

  const apply = () => {
    const lines = data.lines.filter((l) => picked[l.item_id]);
    onApply(lines);
    onOpenChange(false);
  };
  const nPicked = data ? data.lines.filter((l) => picked[l.item_id]).length : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="suggest-issues-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Wand2 size={18} className="text-emerald-600" /> Suggest issues from menu</DialogTitle>
          <DialogDescription data-testid="suggest-subtitle">
            {fmtDateLong(dateStr)} · {data?.menu_day ? `${data.menu_day.name} menu` : busy ? "loading…" : `no recipe menu for ${data?.weekday || "this day"}`}
            {" "}· recipe grams × headcount. Pre-Breakfast & Pre-Training use the Breakfast count; Evenings use the Afternoon Snack count.
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <div className="p-10 flex justify-center"><Loader2 className="animate-spin text-slate-400" /></div>
        ) : (
          <div className="space-y-3">
            <HeadcountRow headcounts={data.headcounts} draft={draft} setDraft={setDraft} busy={busy} onRecalc={() => load(counts())} />
            <div className="iu-card overflow-auto max-h-[40vh]"><SuggestLines lines={data.lines} picked={picked} setPicked={setPicked} /></div>
            <UnmatchedList rows={data.unmatched} canMap={user?.role === "admin"} mapping={mapping} onMap={mapIngredient} />
            <UnitMismatchList rows={data.unit_mismatches} />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => onOpenChange(false)} className="iu-btn-secondary !h-9 text-sm" data-testid="suggest-cancel">Cancel</button>
              <button type="button" onClick={apply} disabled={!nPicked || busy} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="suggest-apply">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Fill {nPicked} item{nPicked === 1 ? "" : "s"} into the issue
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
