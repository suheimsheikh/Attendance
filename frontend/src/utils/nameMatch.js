// Mirror of backend services/id_ocr.name_match_status — order-independent name
// check so persistent red warnings match the server's reject/accept decision.
// Flipped order and small misspellings are ALLOWED but flagged; only a genuine
// different-person "mismatch" is rejected.
const toks = (s) => (s || "").toUpperCase().replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
const eq = (a, b) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));

function lev(a, b) {
  if (a === b) return 0;
  if (!a || !b) return (a || b).length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}
const fuzzy = (a, b) => a.length >= 3 && b.length >= 3 && lev(a, b) <= (Math.min(a.length, b.length) <= 4 ? 1 : 2);

export function nameStatus(card, app) {
  const ca = toks(card), cb = toks(app);
  if (!ca.length || !cb.length) return null;
  const [small, large] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  const used = large.map(() => false);
  const levels = [];
  for (const t of small) {
    let hit = large.findIndex((u, i) => !used[i] && u === t);
    let lvl = "exact";
    if (hit < 0) { hit = large.findIndex((u, i) => !used[i] && t !== u && eq(t, u)); lvl = "initial"; }
    if (hit < 0) { hit = large.findIndex((u, i) => !used[i] && fuzzy(t, u)); lvl = "misspelt"; }
    if (hit < 0) return "mismatch";
    used[hit] = true;
    levels.push(lvl);
  }
  if (levels.includes("misspelt")) return "misspelt";
  if (ca.length !== cb.length || levels.includes("initial")) return "close";
  return ca.join(" ") === cb.join(" ") ? "exact" : "flipped";
}

// Short label shown next to a flagged (non-exact) name.
export const NAME_STATUS_NOTE = {
  flipped: "name order looks flipped — verify",
  misspelt: "spelling differs slightly — verify",
  close: "close match (extra name or an initial) — verify",
  mismatch: "doesn't match app name",
};

const title = (ws) => ws.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");

export function splitSuggestions(name) {
  const t = (name || "").split(/\s+/).filter(Boolean);
  if (t.length < 2) return [{ given_name: title(t), surname: "" }];
  const last = { given_name: title(t.slice(0, -1)), surname: title(t.slice(-1)) };
  const first = { given_name: title(t.slice(1)), surname: title(t.slice(0, 1)) };
  return JSON.stringify(first) === JSON.stringify(last) ? [last] : [last, first];
}
