// Mirror of backend services/id_ocr.name_match_status — order-independent name
// check so persistent red warnings match the server's reject/accept decision.
const toks = (s) => (s || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
const eq = (a, b) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

export function nameStatus(card, app) {
  const ca = toks(card), cb = toks(app);
  if (!ca.length || !cb.length) return null;
  const [small, large] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  const used = large.map(() => false);
  for (const t of small) {
    let hit = large.findIndex((u, i) => !used[i] && u === t);
    if (hit < 0) hit = large.findIndex((u, i) => !used[i] && eq(t, u));
    if (hit < 0) return "mismatch";
    used[hit] = true;
  }
  const sorted = (x) => [...x].sort().join(" ");
  return ca.length === cb.length && sorted(ca) === sorted(cb) ? "exact" : "close";
}

const title = (ws) => ws.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

export function splitSuggestions(name) {
  const t = (name || "").split(/\s+/).filter(Boolean);
  if (t.length < 2) return [{ given_name: title(t), surname: "" }];
  const last = { given_name: title(t.slice(0, -1)), surname: title(t.slice(-1)) };
  const first = { given_name: title(t.slice(1)), surname: title(t.slice(0, 1)) };
  return JSON.stringify(first) === JSON.stringify(last) ? [last] : [last, first];
}
