import { useCallback, useMemo } from "react";
import { useUiPrefs } from "../../../hooks/useUiPrefs";
import { MEMBER_COLUMNS, COLUMN_BY_KEY } from "./columns";

const DEFAULT_ORDER = MEMBER_COLUMNS.map((c) => c.key);
const DEFAULT_HIDDEN = MEMBER_COLUMNS.filter((c) => c.isNew).map((c) => c.key);

// Per-admin column order + visibility, saved in the user's ui-prefs.
export function useMemberColumns() {
  const [prefs, patch] = useUiPrefs({ members_col_order: null, members_col_hidden: null });
  const order = useMemo(() => {
    const saved = (prefs.members_col_order || []).filter((k) => COLUMN_BY_KEY[k]);
    return [...saved, ...DEFAULT_ORDER.filter((k) => !saved.includes(k))];
  }, [prefs.members_col_order]);
  const hidden = useMemo(() => new Set(prefs.members_col_hidden || DEFAULT_HIDDEN), [prefs.members_col_hidden]);
  const visible = useMemo(() => order.filter((k) => !hidden.has(k)).map((k) => COLUMN_BY_KEY[k]), [order, hidden]);

  const move = useCallback((from, to) => {
    if (from === to) return;
    const next = order.filter((k) => k !== from);
    next.splice(next.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
    patch({ members_col_order: next });
  }, [order, patch]);
  const step = useCallback((key, dir) => {
    const i = order.indexOf(key);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    patch({ members_col_order: next });
  }, [order, patch]);
  const toggle = useCallback((key) => {
    const next = new Set(hidden);
    next.has(key) ? next.delete(key) : next.add(key);
    patch({ members_col_hidden: [...next] });
  }, [hidden, patch]);
  const reset = useCallback(() => patch({ members_col_order: null, members_col_hidden: null }), [patch]);

  return { order, hidden, visible, move, step, toggle, reset };
}
