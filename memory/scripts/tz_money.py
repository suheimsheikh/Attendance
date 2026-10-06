import os, re
SRC = "/app/frontend/src"
UTILS = os.path.join(SRC, "utils")  # utils.js module path (no ext)


def rel_utils(path):
    r = os.path.relpath(UTILS, os.path.dirname(path))
    return r if r.startswith(".") else "./" + r


def ensure_import(t, path, names):
    rel = rel_utils(path)
    m = re.search(r'import \{([^}]*)\} from "%s";' % re.escape(rel), t)
    if m:
        have = [x.strip() for x in m.group(1).split(",") if x.strip()]
        add = [n for n in names if n not in have and not any(h.endswith(" as " + n) or h == n for h in have)]
        if not add:
            return t
        new = "import { %s } from \"%s\";" % (", ".join(have + add), rel)
        return t[:m.start()] + new + t[m.end():]
    imports = list(re.finditer(r'^import [^;]*;\n', t, re.M))
    pos = imports[-1].end() if imports else 0
    return t[:pos] + 'import { %s } from "%s";\n' % (", ".join(names), rel) + t[pos:]


def edit(relpath, reps=(), regex=(), names=()):
    try:
        _edit(relpath, reps, regex, names)
    except AssertionError as e:
        print("FAIL", e)


def _edit(relpath, reps, regex, names):
    path = os.path.join(SRC, relpath)
    t = open(path).read()
    for old, new, *cnt in reps:
        c = t.count(old)
        exp = cnt[0] if cnt else 1
        assert c == exp, f"{relpath}: expected {exp} got {c} for {old[:70]!r}"
        t = t.replace(old, new)
    for pat, new in regex:
        t2 = re.sub(pat, new, t)
        assert t2 != t, f"{relpath}: regex no-op {pat}"
        t = t2
    if names:
        t = ensure_import(t, path, list(names))
    open(path, "w").write(t)


TODAY_FN = '''function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
'''
RECENT = lambda n: (f'''    const startD = new Date();
    startD.setDate(startD.getDate() - {n});
    const p = (n) => String(n).padStart(2, "0");
    const start = `${{startD.getFullYear()}}-${{p(startD.getMonth() + 1)}}-${{p(startD.getDate())}}`;
''', f"    const start = isoDaysAgo({n});\n")
ISO_AGO_FN = '''function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("sv-SE");
}
'''
FMT_WRAP = 'const fmt = (n, unit) => (n == null ? "—" : uQty(n, unit));'
R2 = '{ minimumFractionDigits: 2, maximumFractionDigits: 2 }'

# ---------- tasks ----------
edit("pages/tasks/TodosTab.jsx", reps=[
    ('const todayISO = () => new Date().toLocaleDateString("en-CA");\n', ""),
    ('const shiftISO = (iso, delta) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + delta); return d.toLocaleDateString("en-CA"); };\n', ""),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\bshiftISO\(", "addDaysIso(")], names=["todayIso", "addDaysIso"])

# ---------- Meals / Stock ----------
edit("pages/admin/MealCrossCheckTab.jsx", reps=[
    (ISO_AGO_FN, ""), ('const todayISO = () => new Date().toLocaleDateString("sv-SE");\n', ""),
    (FMT_WRAP, "const fmt = uQty;"),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "isoDaysAgo"])

edit("pages/admin/MealNodeDetail.jsx", reps=[
    (ISO_AGO_FN, ""), ('const todayISO = () => new Date().toLocaleDateString("sv-SE");\n', ""),
    (FMT_WRAP, "const fmt = uQty;"),
    (f'const rupee = (n) => (n == null ? "—" : `₹${{Number(n).toLocaleString("en-IN", {R2})}}`);\n', ""),
    ('<Chip label="Spend" value={rupee(tot.purchased_amount)}/>', '<Chip label="Spend" value={rupees(tot.purchased_amount)}/>'),
    ('<Chip label="Spend in range" value={rupee(data.spend)}/>', '<Chip label="Spend in range" value={rupees(data.spend)}/>'),
    ('`${rupee(ev.rate)} → ${rupee(ev.amount)}`', '`${money(ev.rate)} → ${money(ev.amount)}`'),
    ('{r.purchased_amount ? rupee(r.purchased_amount) : "—"}', '{r.purchased_amount ? money(r.purchased_amount) : "—"}'),
    ('<th className="text-right p-2">Rate / Amount</th>', '<th className="text-right p-2">Rate / Amount ₹</th>'),
    ('<th className="text-right p-2">Amount</th>', '<th className="text-right p-2">Amount ₹</th>'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "isoDaysAgo", "money", "rupees"])

edit("pages/admin/MealStockTakeTab.jsx", reps=[
    ('const todayISO = () => new Date().toLocaleDateString("sv-SE");\n', ""),
    ('const rupee = (n) => `₹${Math.abs(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;\n',
     'const rupee = (n) => rupees(Math.abs(Number(n) || 0), 0);\n'),
    ('''    const nextDay = (() => {
      const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + 1);
      return d.toLocaleDateString("sv-SE");
    })();
''', "    const nextDay = addDaysIso(dateStr, 1);\n"),
    ('{loss ? `−${rupee(varValue)}` : `+${rupee(varValue)}`}', '{loss ? "−" : "+"}{money(Math.abs(Number(varValue) || 0), 0)}'),
    ('₹{num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)}', '{num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)}'),
    ('`₹${num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)}`', 'num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "addDaysIso", "money", "rupees"])

edit("pages/admin/DarReport.jsx", reps=[
    ('const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });\n', ""),
    ("const firstOfMonth = (iso) => `${monthOf(iso)}-01`;\n", ""),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\bfirstOfMonth\(", "monthStartIso(")], names=["todayIso", "monthStartIso"])

edit("pages/admin/ItemLedgerDrawer.jsx", reps=[
    (FMT_WRAP, "const fmt = uQty;"),
    (f'const rupee = (n) => (!n ? "—" : `₹${{Number(n).toLocaleString("en-IN", {R2})}}`);\n', ""),
    ('const isoDaysAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toLocaleDateString("sv-SE"); };\n', ""),
    ('const todayISO = () => new Date().toLocaleDateString("sv-SE");\n', ""),
    ('{r.purch_amt ? rupee(r.purch_amt) : ""}', '{r.purch_amt ? money(r.purch_amt) : ""}'),
    ('{rupee(tot.purchased_amount)}', '{tot.purchased_amount ? money(tot.purchased_amount) : "—"}'),
    ('<th className="text-right p-2.5">Amount</th>', '<th className="text-right p-2.5">Amount ₹</th>'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "isoDaysAgo", "money"])

edit("pages/admin/ChefsView.jsx", reps=[
    ('''function todayIso() {
  return new Date().toLocaleDateString("sv-SE");   // YYYY-MM-DD, local
}

''', ""),
], names=["todayIso"])

edit("pages/admin/MealMastersTab.jsx", reps=[
    ('max={new Date().toLocaleDateString("sv-SE")}', "max={todayIso()}"),
    ('title="Opening stock — click any item\'s value to edit">Opening</span>',
     'title="Opening stock — click any item\'s value to edit">Opening <span className="text-slate-400 font-normal normal-case">(qty · ₹)</span></span>'),
], names=["todayIso"])

edit("pages/admin/meal-masters/helpers.js", reps=[
    (f'  n == null || !Number(n) ? "₹0.00" : `₹${{Number(n).toLocaleString("en-IN", {R2})}}`;', '  (!Number(n) ? "0.00" : money(n));'),
], names=["money"])
edit("pages/admin/meal-masters/InlineEditors.jsx", reps=[('"@₹—"', '"@—"')])

edit("pages/admin/StockVarianceReport.jsx", reps=[
    ('const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("sv-SE"); };\n', ""),
    ('const todayISO = () => new Date().toLocaleDateString("sv-SE");\n', ""),
    (f'const rupee = (n) => `₹${{Number(n || 0).toLocaleString("en-IN", {R2})}}`;\n', 'const rupee = (n) => rupees(n || 0);\n'),
    ('{rupee(r.loss_value + r.extra_value)}', '{money(r.loss_value + r.extra_value)}'),
    ('<th className="text-right p-2.5 bg-slate-100">Value impact</th>', '<th className="text-right p-2.5 bg-slate-100">Value impact ₹</th>'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "isoDaysAgo", "money", "rupees"])

edit("pages/admin/MealCompareTab.jsx", reps=[
    ('const todayIso = () => new Date().toLocaleDateString("en-CA");\n', ""),
    ('const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - (n - 1)); return d.toLocaleDateString("en-CA"); };\n',
     "const lastNDaysStart = (n) => isoDaysAgo(n - 1);\n"),
    (f'const inr = (n) => Number(n || 0).toLocaleString("en-IN", {R2});', "const inr = (n) => money(n || 0);"),
    ("useState(isoDaysAgo(90))", "useState(lastNDaysStart(90))"),
    ("setFrom(isoDaysAgo(parseInt(preset, 10)))", "setFrom(lastNDaysStart(parseInt(preset, 10)))"),
], names=["todayIso", "isoDaysAgo", "money"])

edit("pages/admin/Camps.jsx", reps=[('const TODAY_ISO = new Date().toLocaleDateString("sv-SE");\n\n', "")],
     regex=[(r"\bTODAY_ISO\b", "todayIso()")], names=["todayIso"])

edit("pages/admin/StockLedgersPrintButton.jsx", reps=[
    ('''const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("sv-SE");
};
const todayISO = () => new Date().toLocaleDateString("sv-SE");
''', ""),
    (f'const rs = (x) => (x === null || x === undefined ? "" : "₹" + Number(x).toLocaleString("en-IN", {R2}));',
     'const rs = (x) => money(x, 2, "");'),
    ("`avg rate ${rs(l.avg_rate)}/", "`avg rate ₹${rs(l.avg_rate)}/"),
    ("total stock value <b>${rs(data.total_value)}</b>", "total stock value <b>₹${rs(data.total_value)}</b>"),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\bmonthStart\(", "monthStartIso(")], names=["todayIso", "monthStartIso", "money"])

edit("pages/admin/kitchen-analytics/helpers.jsx", reps=[
    ('import { fmtQty as uQty } from "../../../utils";', 'import { fmtQty as uQty, money } from "../../../utils";'),
    ('''export const inr = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
export const inr2 = (n) =>
  n == null ? "—" : Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtQty = (n, unit) =>
  n == null ? "—" : uQty(n, unit);

export function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
''', '''export const inr = (n) => money(n, 0);
export const inr2 = (n) => money(n);
export const fmtQty = uQty;
'''),
])
edit("pages/admin/KitchenAnalyticsTab.jsx", reps=[('import { todayIso } from "./kitchen-analytics/helpers";\n', "")], names=["todayIso"])
edit("pages/admin/kitchen-analytics/nutrition.jsx", reps=[
    ('{r.rate ? `₹${inr2(r.rate)}` : "—"}', '{r.rate ? inr2(r.rate) : "—"}'),
    ('font-semibold">₹{inr2(r.amount)}</td>', 'font-semibold">{inr2(r.amount)}</td>'),
    ('text-amber-900">₹{inr2(u.amount)}</td>', 'text-amber-900">{inr2(u.amount)}</td>'),
    ('<th className="text-right px-2 py-2">Rate</th>\n                    <th className="text-right px-2 py-2">Amount</th>',
     '<th className="text-right px-2 py-2">Rate ₹</th>\n                    <th className="text-right px-2 py-2">Amount ₹</th>'),
])

edit("pages/admin/MealPurchasesTab.jsx", reps=[
    (TODAY_FN, ""), RECENT(30),
    (f'const inr = (n) =>\n  n == null ? "0.00" : Number(n).toLocaleString("en-IN", {R2});', 'const inr = (n) => money(n, 2, "0.00");'),
    ('{amt > 0 ? `₹${inr(amt)}` : ""}', '{amt > 0 ? inr(amt) : ""}'),
    ('{catTotals[cat.key] ? `₹${inr(catTotals[cat.key])}` : "—"}', '{catTotals[cat.key] ? inr(catTotals[cat.key]) : "—"}'),
    ('data-testid="purchase-day-total">₹{inr(dayTotal)}</td>', 'data-testid="purchase-day-total">{inr(dayTotal)}</td>'),
    ('font-bold tabular-nums">₹{inr(tot)}</td>', 'font-bold tabular-nums">{inr(tot)}</td>'),
    ('text-slate-500">₹{inr(o.prev)}</td>', 'text-slate-500">{inr(o.prev)}</td>'),
    ('text-slate-900">₹{inr(o.rate)}</td>', 'text-slate-900">{inr(o.rate)}</td>'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "isoDaysAgo", "money"])

edit("pages/admin/MealExpensesTab.jsx", reps=[
    ('''function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
''', "const currentMonth = () => todayIso().slice(0, 7);\n"),
    (TODAY_FN, ""),
    (f'const inr = (n) =>\n  n == null ? "" : Number(n).toLocaleString("en-IN", {R2});', 'const inr = (n) => money(n, 2, "");'),
], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso", "money"])

edit("pages/admin/MealsReport.jsx", reps=[(TODAY_FN, "")], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso"])

edit("pages/admin/MealWastageTab.jsx", reps=[
    (TODAY_FN, ""), RECENT(30),
    ('const fmtQty = (n, unit) => (n == null ? "0" : uQty(n, unit));\n', ""),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\bfmtQty\(", "uQty(")], names=["todayIso", "isoDaysAgo"])

edit("pages/admin/MealIssuesTab.jsx", reps=[
    (TODAY_FN, ""), RECENT(14),
    ('const fmtQty = (n, unit) => (n == null ? "0" : uQty(n, unit));\n', ""),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\bfmtQty\(", "uQty(")], names=["todayIso", "isoDaysAgo"])

edit("pages/admin/MealsCalendar.jsx", reps=[
    ('''function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
''', ""),
    ('const money = (n) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`);\n', ""),
    (f'const money2 = (n) => (n == null ? "—" : `₹${{Number(n).toLocaleString("en-IN", {R2})}}`);\n', ""),
    ("setFrom(isoDaysAgo(30))", "setFrom(isoDaysAgo(29))"),
], regex=[(r"\bisoToday\(", "todayIso(")], names=["todayIso", "isoDaysAgo", "money", "rupees"])

edit("pages/admin/meal-entry/helpers.js", reps=[
    ('''export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

''', ""),
    (f'export const inr = (n) =>\n  n == null ? "0.00" : Number(n).toLocaleString("en-IN", {R2});', 'export const inr = (n) => money(n, 2, "0.00");'),
], names=["money"])
edit("pages/admin/MealEntryTab.jsx", reps=[
    ('import { todayISO, addDays, num, inr } from "./meal-entry/helpers";', 'import { num, inr } from "./meal-entry/helpers";'),
    ('{purchAmt > 0 ? `₹${inr(purchAmt)}` : <span', '{purchAmt > 0 ? inr(purchAmt) : <span'),
    ('{issueAmt > 0 ? `₹${inr(issueAmt)}` : <span', '{issueAmt > 0 ? inr(issueAmt) : <span'),
    ('{wastageAmt > 0 ? `₹${inr(wastageAmt)}` : <span', '{wastageAmt > 0 ? inr(wastageAmt) : <span'),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\baddDays\(", "addDaysIso(")], names=["todayIso", "addDaysIso"])
edit("pages/admin/meal-entry/DailyTotalsHistoryModal.jsx", reps=[
    ('import { addDays, todayISO, inr } from "./helpers";', 'import { inr } from "./helpers";'),
    ("₹{inr(r.purchase_amt)}", "{inr(r.purchase_amt)}"), ("₹{inr(r.issue_amt)}", "{inr(r.issue_amt)}"),
    ("₹{inr(totals.grand_purchase_amt)}", "{inr(totals.grand_purchase_amt)}"), ("₹{inr(totals.grand_issue_amt)}", "{inr(totals.grand_issue_amt)}"),
], regex=[(r"\btodayISO\(", "todayIso("), (r"\baddDays\(", "addDaysIso(")], names=["todayIso", "addDaysIso"])
edit("pages/admin/meal-entry/EntryItemRow.jsx", reps=[
    ('{purchAmt > 0 ? `₹${inr(purchAmt)}` : ""}', '{purchAmt > 0 ? inr(purchAmt) : ""}'),
    ('{rate > 0 ? `₹${inr(rate)}` : "—"}', '{rate > 0 ? inr(rate) : "—"}'),
    ('{issueAmt > 0 ? `₹${inr(issueAmt)}` : ""}', '{issueAmt > 0 ? inr(issueAmt) : ""}'),
    ('{wasteAmt > 0 ? `₹${inr(wasteAmt)}` : ""}', '{wasteAmt > 0 ? inr(wasteAmt) : ""}'),
])

edit("pages/admin/MealPriceMoversTab.jsx", reps=[
    (f'const rupee = (n) => (n == null ? "—" : `₹${{Number(n).toLocaleString("en-IN", {R2})}}`);\n', ""),
    ('''function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
''', ""),
    ("{rupee(m.base_rate)} <span", "{rupees(m.base_rate)} <span"), ("<b className=\"text-slate-700\">{rupee(m.cur_rate)}</b>", "<b className=\"text-slate-700\">{rupees(m.cur_rate)}</b>"),
    ("(${rupee(p.payload.base_rate)} → ${rupee(p.payload.cur_rate)})", "(${rupees(p.payload.base_rate)} → ${rupees(p.payload.cur_rate)})"),
    ('text-slate-500">{rupee(m.base_rate)}</td>', 'text-slate-500">{money(m.base_rate)}</td>'),
    ('text-slate-800">{rupee(m.cur_rate)}</td>', 'text-slate-800">{money(m.cur_rate)}</td>'),
    ('<th className="text-right p-2.5">Prev rate</th>\n                  <th className="text-right p-2.5">Now</th>',
     '<th className="text-right p-2.5">Prev rate ₹</th>\n                  <th className="text-right p-2.5">Now ₹</th>'),
], names=["todayIso", "money", "rupees"])

edit("pages/admin/ProcurementPlanTab.jsx", reps=[
    ('const inr = (n) =>\n  Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });', "const inr = (n) => money(n || 0, 0);"),
    ('{r.est_amount > 0 ? `₹${inr(r.est_amount)}` : "—"}', '{r.est_amount > 0 ? inr(r.est_amount) : "—"}'),
], names=["money"])
edit("pages/admin/MealVendorsTab.jsx", reps=[
    (f'const inr = (n) =>\n  n == null ? "0.00" : Number(n).toLocaleString("en-IN", {R2});', 'const inr = (n) => money(n, 2, "0.00");'),
], names=["money"])
edit("components/VendorScorecardDrawer.jsx", reps=[
    (f'const inr = (n) =>\n  n == null ? "—" : Number(n).toLocaleString("en-IN", {R2});', "const inr = (n) => money(n);"),
    ('const fmtQty = (n, unit) =>\n  n == null ? "—" : uQty(n, unit);', "const fmtQty = uQty;"),
    ("                          ₹{inr(it.spend)}\n", "                          {inr(it.spend)}\n"),
    ('<th className="text-right px-2 py-2">Spend</th>', '<th className="text-right px-2 py-2">Spend ₹</th>'),
], names=["money"])
edit("components/ItemPriceTrendDrawer.jsx", reps=[
    (f'const inr = (n) =>\n  n == null ? "—" : Number(n).toLocaleString("en-IN", {R2});', "const inr = (n) => money(n);"),
    ('const fmtQty = (n, unit) =>\n  n == null ? "—" : uQty(n, unit);', "const fmtQty = uQty;"),
    ('font-semibold">₹{inr(p.rate)}</td>', 'font-semibold">{inr(p.rate)}</td>'),
    ('text-emerald-700">₹{inr(p.amount)}</td>', 'text-emerald-700">{inr(p.amount)}</td>'),
    ('<th className="text-right pr-3 pl-2 py-2">Amount</th>', '<th className="text-right pr-3 pl-2 py-2">Amount ₹</th>'),
], names=["money"])
edit("pages/admin/MealsDataHealth.jsx", reps=[
    ('<span title="Last purchase rate">₹{it.suggested_rate}</span>', '<span title="Last purchase rate">{it.suggested_rate}</span>'),
    ('(it.opening_rate > 0 ? `₹${it.opening_rate}` : "—")', '(it.opening_rate > 0 ? it.opening_rate : "—")'),
    ('{mode === "rate" ? "Suggested ₹" : "Rate"}', '{mode === "rate" ? "Suggested ₹" : "Rate ₹"}'),
])

edit("pages/Meals.jsx", reps=[('''function todayISO() {
  // Office-local date is the source of truth on the backend, but for
  // the picker default we use the browser's local date — same TZ in
  // practice (IST) and avoids a round-trip.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

''', "")], regex=[(r"\btodayISO\(", "todayIso(")], names=["todayIso"])

# ---------- rest of the app: "today" ----------
edit("pages/admin/DataQuality.jsx", reps=[
    ('  const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("sv-SE"); };\n', ""),
    ('  const today = () => new Date().toLocaleDateString("sv-SE");\n', ""),
], regex=[(r"\bmonthStart\(\)", "monthStartIso()"), (r"\btoday\(\)", "todayIso()")], names=["todayIso", "monthStartIso"])
edit("components/RecalcTimingsDialog.jsx", reps=[
    ('const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString("sv-SE"); };\n', ""),
    ('const today = () => new Date().toLocaleDateString("sv-SE");\n', ""),
], regex=[(r"\bmonthStart\(\)", "monthStartIso()"), (r"\btoday\(\)", "todayIso()")], names=["todayIso", "monthStartIso"])
edit("pages/admin/Members.jsx", reps=[
    ('useMemo(() => new Date().toLocaleDateString("sv-SE"), [])', "useMemo(() => todayIso(), [])"),
    ("staff_roster_${new Date().toISOString().slice(0,10)}.xlsx", "staff_roster_${todayIso()}.xlsx"),
], names=["todayIso"])
edit("pages/admin/Institutions.jsx", reps=[
    ('new Date().toLocaleDateString("sv-SE")', "todayIso()", 2),
    ("const today = new Date(); today.setHours(0, 0, 0, 0);", "const today = academyToday();"),
], names=["todayIso", "academyToday"])
edit("pages/Presence.jsx", reps=[
    ('  const todayIso = useCallback(() => new Date().toLocaleDateString("sv-SE"), []);\n', ""),
    ('''  const shiftIso = useCallback((iso, delta) => {
    const d = new Date(iso + "T12:00:00");  // noon avoids DST edge cases
    d.setDate(d.getDate() + delta);
    return d.toLocaleDateString("sv-SE");
  }, []);
''', ""),
    ("shiftIso={shiftIso}", "shiftIso={addDaysIso}"),
], names=["todayIso", "addDaysIso"])
edit("components/AbsentDispatchPrompt.jsx", reps=[('''function todayKey() {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD local
}
''', "const todayKey = todayIso;\n")], names=["todayIso"])
edit("pages/admin/Reports.jsx", reps=[("const _now = new Date();", "const _now = academyToday();")], names=["academyToday"])
edit("pages/admin/reports/utils.js", reps=[("  const today = new Date();\n", "  const today = academyToday();\n")], names=["academyToday"])
edit("pages/admin/dashboard/MonthCorrectionsCard.jsx", reps=[('''function currentMonthIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
''', "const currentMonthIso = () => todayIso().slice(0, 7);\n")], names=["todayIso"])
edit("components/UpcomingThisWeek.jsx", reps=[
    ('''    const today = ymd(new Date());
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 7);
    const horizonStr = ymd(horizon);
''', "    const today = todayIso();\n    const horizonStr = addDaysIso(today, 7);\n"),
    ("  const today = ymd(new Date());\n", "  const today = todayIso();\n"),
], names=["todayIso", "addDaysIso"])
edit("pages/admin/Calendar.jsx", reps=[
    ("useState(startOfMonth(new Date()))", "useState(startOfMonth(academyToday()))"),
    ("const todayKey = ymd(new Date());", "const todayKey = todayIso();"),
], names=["todayIso", "academyToday"])
edit("pages/admin/calendar/BreakForm.jsx", reps=[("const today = ymd(new Date());", "const today = todayIso();")], names=["todayIso"])
edit("pages/admin/calendar/RegattaForm.jsx", reps=[("const today = ymd(new Date());", "const today = todayIso();")], names=["todayIso"])
edit("components/presence/EscortsStrip.jsx", reps=[("    const today = new Date();\n    today.setHours(0, 0, 0, 0);\n", "    const today = academyToday();\n")], names=["academyToday"])
edit("pages/SelfCheckIn.jsx", reps=[
    ("  const now = new Date();\n  const todayMD = `${String(now.getMonth() + 1).padStart(2, \"0\")}-${String(now.getDate()).padStart(2, \"0\")}`;\n",
     "  const todayMD = todayIso().slice(5);\n"),
], names=["todayIso"])
edit("pages/Muster.jsx", reps=[
    ('const dayStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });',
     'const dayStr = academyToday().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });'),
    ("dateIso: new Date().toISOString().slice(0, 10),", "dateIso: todayIso(),"),
], names=["todayIso", "academyToday"])
edit("pages/EscortCheckIn.jsx", reps=[
    ("dateIso: (att.check_in_at ? new Date(att.check_in_at) : new Date()).toISOString().slice(0, 10),",
     "dateIso: att.check_in_at ? academyDateOf(att.check_in_at) : todayIso(),"),
], names=["todayIso", "academyDateOf"])
edit("pages/admin/CalendarGridTab.jsx", reps=[("new Date().toISOString().slice(0, 10)", "todayIso()")], names=["todayIso"])
edit("pages/admin/approvals/DecisionHistory.jsx", reps=[("leave-decisions-${new Date().toISOString().slice(0, 10)}.csv", "leave-decisions-${todayIso()}.csv")], names=["todayIso"])
edit("components/CorrectionRequestModal.helpers.js", reps=[
    ("export function windowMaxDate() {\n  return new Date().toISOString().slice(0, 10);\n}", "export const windowMaxDate = todayIso;"),
    ("export function windowMinDate() {\n  const d = new Date();\n  d.setDate(d.getDate() - 31);\n  return d.toISOString().slice(0, 10);\n}", "export const windowMinDate = () => isoDaysAgo(31);"),
], names=["todayIso", "isoDaysAgo"])
edit("pages/admin/MealsAnalyticsPanel.jsx", reps=[
    ('''        const cur = new Date(s + "T00:00:00");
        const endD = new Date(e + "T00:00:00");
        while (cur <= endD) {
          const iso = cur.toISOString().slice(0, 10);
          const key = DOW_KEYS[cur.getDay()];''', '''        for (let iso = s; iso <= e; iso = addDaysIso(iso, 1)) {
          const key = DOW_KEYS[new Date(iso + "T00:00:00").getDay()];'''),
    ('''            const prev = new Date(cur); prev.setDate(prev.getDate() - 1);
            out.push({ kind: k, name: ev.name, start_date: segStart,
                       end_date: prev.toISOString().slice(0, 10), segment: idx++, ev_full: ev });''',
     '''            out.push({ kind: k, name: ev.name, start_date: segStart,
                       end_date: addDaysIso(iso, -1), segment: idx++, ev_full: ev });'''),
    ("          }\n          cur.setDate(cur.getDate() + 1);\n        }\n", "          }\n        }\n"),
], names=["addDaysIso"])
print("ok")
