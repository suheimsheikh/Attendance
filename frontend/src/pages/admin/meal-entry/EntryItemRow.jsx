/**
 * EntryItemRow — one item line on the Daily-entry grid, split into four
 * scannable cell-groups: LeadCells (name / unit / on-hand),
 * PurchaseCells (supplier / qty / rate / amount), IssueCells (qty /
 * rate / amount) and WastageCells (qty / reason+note / amount).
 *
 * All four share a single `ctx` bundle (parent state setters, refs,
 * data and focus helpers) so the call sites stay tiny and there is no
 * per-prop drift. Extracted verbatim from MealEntryTab.jsx on
 * 25 Jun 2026 — zero behaviour change.
 */
import React from "react";
import { StickyNote, X } from "lucide-react";
import { toast } from "sonner";
import { fmtQty } from "../../../utils";
import { num, inr } from "./helpers";
import RowVendorPicker from "./RowVendorPicker";

function LeadCells({ it, oh, peer, ctx }) {
  const { setLedgerItem } = ctx;
  return (
    <>
      <td
        className="p-2 cursor-pointer select-none"
        onDoubleClick={() => setLedgerItem({ id: it.id, name: it.name, unit: it.unit })}
        title="Double-click for this item's stock ledger — purchases, issues, wastage and running on-hand balance"
        data-testid={`entry-item-name-${it.id}`}
      >
        <div className="font-semibold text-slate-900 flex items-center gap-1.5 hover:text-sky-700">
          <span>{it.name}</span>
          {peer && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider text-sky-700 bg-sky-100 border border-sky-200 rounded px-1 py-0.5"
              title={`${peer.name} is editing this row now — the value may change under you`}
              data-testid={`entry-row-peer-${it.id}`}
            >
              ✎ {peer.name.split(" ")[0]}
            </span>
          )}
        </div>
      </td>
      <td className="px-1 py-2 text-slate-500 text-xs">{it.unit}</td>
      <td className="px-1 py-2 text-right tabular-nums text-slate-600" data-testid={`entry-onhand-${it.id}`}>
        {oh != null ? (
          oh < 0
            ? <span
                className="font-extrabold text-rose-700"
                title={`Stock is negative (${fmtQty(oh, it.unit)}) — likely from over-issuing on a past day. Reconcile before fresh issues.`}
                data-testid={`entry-onhand-negative-${it.id}`}
              >{fmtQty(oh, it.unit)}</span>
            : oh === 0
              ? <span className="font-semibold text-rose-500" title="Zero stock — nothing to issue">{fmtQty(oh, it.unit)}</span>
              : fmtQty(oh, it.unit)
        ) : "—"}
      </td>
    </>
  );
}

function PurchaseCells({ it, catKey, e, purchAmt, ctx }) {
  const {
    vendors, flatVisibleItemIds, latestPurch,
    setRowVendor, setShowAddVendor, setScorecardVendorId, focusCell, focusPicker,
    setPurchField, notifyFocus, notifyBlur, queuePurch, onGridKeyDown,
  } = ctx;
  return (
    <>
      <td className="p-2 border-l-2 border-emerald-100">
        {/* Per-row Supplier column — visible dropdown so the chef can
            set or change the vendor for this one item. Picking here also
            updates the sticky "last-used" default that auto-fills the
            next blank row the chef touches. */}
        <RowVendorPicker
          rowVendorId={e.vendor_id || ""}
          vendors={vendors}
          onChange={(v) => setRowVendor(it.id, v)}
          onAddNew={() => setShowAddVendor({ catKey, itemId: it.id })}
          onOpenScorecard={(v) => setScorecardVendorId(v.id)}
          onArrowRight={() => focusCell("purch-qty", it.id)}
          onArrowUp={() => {
            const idx = flatVisibleItemIds.indexOf(it.id);
            const prev = flatVisibleItemIds[idx - 1];
            if (prev) focusPicker("row-vendor", prev);
          }}
          onArrowDown={() => {
            const idx = flatVisibleItemIds.indexOf(it.id);
            const next = flatVisibleItemIds[idx + 1];
            if (next) focusPicker("row-vendor", next);
          }}
          testid={`entry-row-vendor-${it.id}`}
        />
      </td>
      <td className="p-2">
        <input
          type="number" min="0" step="0.01"
          value={e.qty ?? ""}
          onChange={(ev) => setPurchField(it.id, "qty", ev.target.value)}
          onFocus={() => notifyFocus("purch", it.id)}
          onBlur={() => { notifyBlur("purch", it.id); queuePurch(); }}
          onKeyDown={onGridKeyDown("purch-qty", it.id)}
          className="iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums"
          placeholder="0"
          data-testid={`entry-purch-qty-${it.id}`}
        />
      </td>
      <td className="p-2">
        <input
          type="number" min="0" step="0.01"
          value={e.rate ?? ""}
          onChange={(ev) => setPurchField(it.id, "rate", ev.target.value)}
          onFocus={() => notifyFocus("purch", it.id)}
          onBlur={() => {
            // Snap the typed rate to a fixed 2-decimal string on blur so
            // the column reads as proper currency (e.g. "50" → "50.00",
            // "60.5" → "60.50"). Empty stays empty.
            const raw = latestPurch.current[it.id]?.rate;
            if (raw !== undefined && raw !== "" && !isNaN(Number(raw))) {
              const fixed = Number(raw).toFixed(2);
              if (fixed !== String(raw)) setPurchField(it.id, "rate", fixed);
            }
            notifyBlur("purch", it.id);
            queuePurch();
          }}
          onKeyDown={onGridKeyDown("purch-rate", it.id)}
          className="iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums"
          placeholder="0.00"
          data-testid={`entry-purch-rate-${it.id}`}
        />
      </td>
      <td className="p-2 text-right font-semibold tabular-nums text-emerald-700" data-testid={`entry-purch-amt-${it.id}`}>
        {purchAmt > 0 ? `₹${inr(purchAmt)}` : ""}
      </td>
    </>
  );
}

function IssueCells({ it, oh, avail, issueQty, rate, issueAmt, over, ctx }) {
  const { setIssues, dirtyIssues, notifyFocus, notifyBlur, queueIssues, onGridKeyDown } = ctx;
  const cap = avail != null ? avail : oh;
  const clearRow = () => {
    dirtyIssues.current.add(it.id);
    setIssues((prev) => ({ ...prev, [it.id]: "" }));
    notifyBlur("issue", it.id);
    queueIssues();
    toast.info(`Cleared ${it.name} issue — stock recalculated`, { id: `clr-${it.id}`, duration: 3000 });
  };
  return (
    <>
      <td className="p-2 border-l-2 border-amber-100">
        <div className="relative">
          <input
            type="number" min="0" step="0.01"
            value={issueQty ?? ""}
            onChange={(ev) => { const v = ev.target.value; dirtyIssues.current.add(it.id); setIssues((prev) => ({ ...prev, [it.id]: v })); }}
            onFocus={() => notifyFocus("issue", it.id)}
            onBlur={() => {
              notifyBlur("issue", it.id);
              // Fat-finger guard at commit: warn if the issue exceeds what's
              // available today (start-of-day on-hand + today's purchases).
              // The server hard-blocks a true shortage; this is the heads-up.
              const q = num(issueQty);
              if (cap != null && q > cap + 1e-6) {
                toast.warning(
                  `Issuing ${fmtQty(q, it.unit)} ${it.unit} of ${it.name} — only ${fmtQty(cap, it.unit)} available (on-hand + today's purchase). Record a purchase first.`,
                  { duration: 6000 },
                );
              }
              queueIssues();
            }}
            onKeyDown={onGridKeyDown("issue-qty", it.id)}
            className={`iu-input !h-8 !px-2 pr-6 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`}
            placeholder="0"
            data-testid={`entry-issue-qty-${it.id}`}
            title={over ? "Issues exceed what's available (on-hand + today's purchase) — record the purchase first" : ""}
          />
          {num(issueQty) > 0 && (
            <button type="button" onClick={clearRow} tabIndex={-1}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50"
              title="Null this issue and recalculate stock" data-testid={`entry-issue-clear-${it.id}`}>
              <X size={12}/>
            </button>
          )}
        </div>
      </td>
      {/* Issue Rate — weighted-avg purchase cost, read-only. */}
      <td className="p-2 text-right tabular-nums text-slate-500 text-xs" data-testid={`entry-issue-rate-${it.id}`} title="Weighted-average purchase cost across all recorded purchases">
        {rate > 0 ? `₹${inr(rate)}` : "—"}
      </td>
      <td className="p-2 text-right font-semibold tabular-nums text-amber-700" data-testid={`entry-issue-amt-${it.id}`}>
        {issueAmt > 0 ? `₹${inr(issueAmt)}` : ""}
      </td>
    </>
  );
}

function WastageCells({ it, w, wasteAmt, over, notesEditor, ctx }) {
  const {
    reasons, flatVisibleItemIds,
    setWastageField, notifyFocus, notifyBlur, queueWastage, onGridKeyDown,
    focusCell, focusPicker, setRowReason, setNotesEditor, setWastageNotes,
  } = ctx;
  return (
    <>
      {/* Wastage half — Qty + Reason + Amount. Both Issues and Wastage
          deplete stock, so the "over" warning fires on the combined
          total. */}
      <td className="p-2 border-l-2 border-rose-100">
        <input
          type="number" min="0" step="0.01"
          value={w.qty ?? ""}
          onChange={(ev) => setWastageField(it.id, "qty", ev.target.value)}
          onFocus={() => notifyFocus("wastage", it.id)}
          onBlur={() => { notifyBlur("wastage", it.id); queueWastage(); }}
          onKeyDown={onGridKeyDown("wastage-qty", it.id)}
          className={`iu-input !h-8 !px-2 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`}
          placeholder="0"
          data-testid={`entry-wastage-qty-${it.id}`}
          title={over ? "Issues + Wastage exceed on-hand — will drive stock negative" : "Quantity lost to wastage / spoilage"}
        />
      </td>
      <td className="p-2 relative">
        <div className="flex items-center gap-1">
          <select
            value={w.reason || ""}
            onChange={(ev) => setRowReason(it.id, ev.target.value)}
            onKeyDown={(ev) => {
              // Arrows navigate between cells; click / Space still open
              // the dropdown natively for picking a value.
              if (ev.key === "ArrowLeft") { ev.preventDefault(); focusCell("wastage-qty", it.id); }
              else if (ev.key === "ArrowUp") {
                ev.preventDefault();
                const idx = flatVisibleItemIds.indexOf(it.id);
                const prev = flatVisibleItemIds[idx - 1];
                if (prev) focusPicker("wastage-reason", prev);
              } else if (ev.key === "ArrowDown") {
                ev.preventDefault();
                const idx = flatVisibleItemIds.indexOf(it.id);
                const next = flatVisibleItemIds[idx + 1];
                if (next) focusPicker("wastage-reason", next);
              }
            }}
            className={`iu-input !h-8 !px-2 text-xs flex-1 min-w-0 text-slate-700 ${w.reason ? "font-semibold" : "text-slate-400"}`}
            data-testid={`entry-wastage-reason-${it.id}`}
            title="Why this stock was lost. Click or press Space to pick; arrow keys move between cells."
          >
            <option value="">— pick reason —</option>
            {reasons.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          {/* Notes icon — subtle when empty, rose when a note exists.
              Hover shows the note as a native tooltip; click opens a
              popover to edit it. */}
          <button
            type="button"
            onClick={() => setNotesEditor(notesEditor === it.id ? null : it.id)}
            title={w.notes ? `Note: ${w.notes}` : "Add a note about why this was wasted"}
            className={`shrink-0 p-1 rounded transition ${w.notes ? "text-rose-500 hover:bg-rose-100" : "text-slate-300 hover:text-slate-600 hover:bg-slate-100"}`}
            data-testid={`entry-wastage-notes-btn-${it.id}`}
          >
            <StickyNote size={13}/>
          </button>
        </div>
        {notesEditor === it.id && (
          <div className="absolute right-0 top-full mt-1 z-40 w-64 bg-white border border-slate-300 rounded-lg shadow-lg p-2" data-testid={`entry-wastage-notes-popover-${it.id}`}>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Note · {it.name}</span>
              <button type="button" onClick={() => setNotesEditor(null)} className="p-0.5 rounded hover:bg-slate-100 text-slate-400" title="Close">
                <X size={12}/>
              </button>
            </div>
            <textarea
              autoFocus
              rows={3}
              value={w.notes || ""}
              onChange={(ev) => setWastageNotes(it.id, ev.target.value)}
              placeholder="e.g. left in sun, spoiled"
              className="iu-input !h-auto !py-1.5 text-xs w-full"
              data-testid={`entry-wastage-notes-textarea-${it.id}`}
            />
          </div>
        )}
      </td>
      <td className="p-2 text-right font-semibold tabular-nums text-rose-700" data-testid={`entry-wastage-amt-${it.id}`}>
        {wasteAmt > 0 ? `₹${inr(wasteAmt)}` : ""}
      </td>
    </>
  );
}

export default function EntryItemRow({ it, catKey, e, oh, issueQty, rate, w, peer, notesEditor, ctx }) {
  const purchAmt = num(e.qty) * num(e.rate);
  const issueAmt = num(issueQty) * rate;
  const wasteAmt = num(w.qty) * rate;
  // Available today = on-hand at start of day + what's purchased today
  // (purchase-before-issue). Overshoot on issues + wastage combined.
  const avail = oh != null ? oh + num(e.qty) : null;
  const over = avail != null && (num(issueQty) + num(w.qty)) > avail + 1e-6;
  return (
    <tr className={`border-t border-slate-100 hover:bg-slate-50/70 ${over ? "bg-rose-50/60" : peer ? "bg-sky-50/40" : ""}`} data-testid={`entry-row-${it.id}`}>
      <LeadCells it={it} oh={oh} peer={peer} ctx={ctx} />
      <PurchaseCells it={it} catKey={catKey} e={e} purchAmt={purchAmt} ctx={ctx} />
      <IssueCells it={it} oh={oh} avail={avail} issueQty={issueQty} rate={rate} issueAmt={issueAmt} over={over} ctx={ctx} />
      <WastageCells it={it} w={w} wasteAmt={wasteAmt} over={over} notesEditor={notesEditor} ctx={ctx} />
    </tr>
  );
}
