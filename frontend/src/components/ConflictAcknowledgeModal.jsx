import React, { useState } from "react";
import { Loader2, Check, Tent, Sailboat, ShieldAlert } from "lucide-react";
import { shortDate } from "../utils";

/**
 * ConflictAcknowledgeModal — reusable "I've read this" gate shown when
 * a Leave/Tour/Posting action (approve on admin side, submit on
 * member side) is about to be taken and the target window overlaps
 * one or more Camps / Regattas.
 *
 * Deliberately un-opinionated on wording — the caller passes
 * `heading`, `subheading`, `ackLabel`, and `confirmLabel` so the same
 * modal can front admin approval AND member self-apply flows without
 * either sounding stilted.
 *
 * Props:
 *  - open: boolean — mount / unmount gate. Callers pass `false` and
 *    the modal renders nothing.
 *  - camps: [{id, name, start_date, end_date, institution?, ...}]
 *  - regattas: [{id, name, start_date, end_date, location?, ...}]
 *  - heading: modal title text.
 *  - subheading: React node — description of what's happening.
 *  - ackLabel: text next to the "I've read" checkbox.
 *  - confirmLabel: button label once the checkbox is ticked.
 *  - onCancel(): called when Cancel or backdrop-click fires.
 *  - onConfirm(): awaited when Confirm fires. During the await the
 *    Confirm button shows a spinner; the modal doesn't self-close
 *    (caller unmounts by flipping `open` after their side-effect).
 *  - testIdPrefix: data-testid namespace so multiple gates on-screen
 *    don't collide.
 */
export default function ConflictAcknowledgeModal({
  open,
  camps = [],
  regattas = [],
  heading,
  subheading,
  ackLabel,
  confirmLabel = "Confirm",
  onCancel,
  onConfirm,
  testIdPrefix = "conflict-gate",
}) {
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  return (
    <div
      className="iu-modal"
      data-testid={testIdPrefix}
      // Stop propagation before checking the backdrop-close condition so
      // clicks inside this modal never leak to an OUTER modal's backdrop
      // onClick (e.g. when this gate is rendered from inside ApplyForm on
      // MyLeaves — that outer modal's onClick={onClose} would otherwise
      // close the whole apply-leave form the moment you tick the "I've
      // reviewed" checkbox).
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="iu-modal-card max-w-lg">
        <header className="p-4 border-b border-amber-100 bg-amber-50/60 rounded-t-lg flex items-start gap-3">
          <ShieldAlert size={22} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-extrabold text-slate-900 text-sm">{heading}</h3>
            {subheading && <div className="text-xs text-slate-600 mt-0.5">{subheading}</div>}
          </div>
        </header>

        <div className="p-4 space-y-3 max-h-[50vh] overflow-y-auto">
          {camps.length > 0 && (
            <ConflictList
              icon={<Tent size={11} />}
              label={`Camps (${camps.length})`}
              testId={`${testIdPrefix}-camps`}
              items={camps}
              renderItem={(c) => (
                <>
                  <span className="font-semibold text-amber-900 flex-1">{c.name}</span>
                  <span className="font-mono text-[10px] text-amber-800 shrink-0">
                    {shortDate(c.start_date)}
                    {c.start_date !== c.end_date && ` → ${shortDate(c.end_date)}`}
                  </span>
                </>
              )}
              itemTestId={(c) => `${testIdPrefix}-camp-${c.id}`}
            />
          )}
          {regattas.length > 0 && (
            <ConflictList
              icon={<Sailboat size={11} />}
              label={`Regattas (${regattas.length})`}
              testId={`${testIdPrefix}-regattas`}
              items={regattas}
              renderItem={(r) => (
                <>
                  <span className="font-semibold text-amber-900 flex-1">
                    {r.name}
                    {r.location && <span className="text-amber-700/70 font-normal"> · {r.location}</span>}
                  </span>
                  <span className="font-mono text-[10px] text-amber-800 shrink-0">
                    {shortDate(r.start_date)}
                    {r.start_date !== r.end_date && ` → ${shortDate(r.end_date)}`}
                  </span>
                </>
              )}
              itemTestId={(r) => `${testIdPrefix}-regatta-${r.id}`}
            />
          )}
        </div>

        <div className="px-4 pb-4">
          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              data-testid={`${testIdPrefix}-ack-checkbox`}
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
            />
            <span>{ackLabel}</span>
          </label>
        </div>

        <div className="p-3 border-t border-slate-100 flex gap-2 bg-slate-50/40 rounded-b-lg">
          <button
            type="button"
            onClick={onCancel}
            className="iu-btn-secondary flex-1"
            data-testid={`${testIdPrefix}-cancel`}
          >Cancel</button>
          <button
            type="button"
            onClick={submit}
            disabled={!ack || busy}
            data-testid={`${testIdPrefix}-confirm`}
            className="iu-btn-primary flex-1"
          >
            {busy ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConflictList({ icon, label, items, renderItem, testId, itemTestId }) {
  return (
    <div data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mb-1.5 inline-flex items-center gap-1">
        {icon} {label}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li
            key={it.id}
            data-testid={itemTestId(it)}
            className="text-xs bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-baseline gap-2"
          >
            {renderItem(it)}
          </li>
        ))}
      </ul>
    </div>
  );
}
