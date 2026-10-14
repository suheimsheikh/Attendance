# Engineering lessons / gotchas

## NEVER PUT whole-day Meals data on a REAL date when testing (14 Jun 2026)
The Meals Purchases/Issues/Wastage/Stock-take `PUT /meals/{purchases|issues|...}/{date}`
endpoints REPLACE the whole day's lines. Calling them against a real historical/current
date destroys that day's real kitchen data.
- During cap-validation testing I PUT to `2026-06-15` and wiped the day's single Curd line.
- Recovered it from the `audit_log` collection (the zero-save recorded the removed line in
  `meta.changes` with before-values: Curd 3kg @ ₹70, vendor 7d0b4492-...). Restored the doc
  and deleted the two test audit rows.
- RULE: for any write test on meals, use a synthetic far-future date (e.g. 2027-01-05) or a
  single-line PATCH, never a whole-day PUT on a real date. (Same rule is noted in
  test_credentials.md for the pytest suite.)
- The audit collection is `audit_log` (not `audit_logs`); it stores line-level diffs in
  `meta.changes` — useful for reconstructing clobbered meal docs.
