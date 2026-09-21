# Payroll Grid: daily punch metadata

## Request
`GET {BASE}/api/grid?month=YYYY-MM&key={GRID_API_KEY}&category=all`

Existing integration key only; no user login, session or DAR request is required.
Use the existing secret from your server environment. Do not log or publish the
key-bearing URL. No key values changed with this feature.

## Response addition
Each `rows[]` item retains its original fields. Its formerly empty `cell_meta`
now contains one entry for each date in the top-level `days` array:

```json
{
  "2026-09-09": {"code": "P", "in": "09:30", "out": "18:00"},
  "2026-09-10": {"code": "LT", "in": "10:05", "out": null},
  "2026-09-15": {"code": "LV"},
  "2026-09-30": {"code": ""}
}
```

- Times: zero-padded 24-hour `HH:MM`, in the configured office timezone
  (currently `Asia/Kolkata`, as confirmed by the user).
- `code` is always exactly the corresponding value in `cells`.
- Every Grid-classified worked day (P/LT/HD) includes both
  `in` and `out`. Missing or unusable punches are explicitly `null`.
- No fabricated checkout: `missing_checkout` rows (and legacy uncorrected
  auto-closures) return `out: null`, even if a synthetic close timestamp exists.
  An admin-corrected real checkout remains available.
- Naive correction timestamps represent office-local wall time; offset-aware
  punches are converted into the office timezone.
- Dates without a worked-day code have only `code`:
  WO/HO/LV/TR/PS/CO/BK/AB/LP/NJ/LF and blank future/in-progress cells.
- Code-only days omit both punch fields even if a stale attendance record
  exists (for example, a punch before joining or a manual leave override).
  Codes and totals remain untouched. A P/LT/HD override without punches
  returns both `in: null` and `out: null`.
- `cells`, `totals`, schedules and all other legacy fields are unchanged.
  UI tooltip notes/reasons are not exposed through this key-based endpoint.

## Category filters
- Omitted or `all`: all members included by the existing Grid roster rules.
- `staff`, `coach`, `executive`, or a custom category key: exact category.
- Existing `athlete`, `elite`, `rest`, `payroll` buckets retain their previous
  meanings for compatibility (`athlete` includes configured athlete-like
  categories; `payroll` includes staff + coaches). An unknown exact key returns
  no rows instead of broadening the query to everyone.
- Existing `fleet` and `institution` filters continue to apply.

## Payroll use
Read `rows[i].cell_meta[date].in` and `.out`. Treat `null` as an incomplete
day requiring correction, not zero hours or a scheduled checkout. HH:MM alone
does not encode next-day checkout dates or multiple legacy sessions; this
endpoint intentionally continues to use the Grid's existing daily record.