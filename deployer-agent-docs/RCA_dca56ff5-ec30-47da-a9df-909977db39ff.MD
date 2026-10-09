# RCA — "LATE" missing in WhatsApp check-in caption (Preethi)

**Mode:** READ-ONLY production data check. Nothing was modified.
**DB read:** `attendance-portal-56-test_database` (prod, resolved from run `dca56ff5-...`).

## Verdict
The production DB holds **correct** `late` / `late_minutes` values for this member — including `late=true` on her **most recent / open session**. The data is NOT the source of the missing "LATE" caption. The discrepancy is downstream of the DB (geo-toggle response serialization or the client caption builder).

## 1. users — db.users.find({full_name:/preethi/i})
- id: `3c2538dc-bf3d-4dac-b0e4-ee84479547a6`
- full_name: `PREETHI KONGARA`
- category: `coach`
- custom_category: *(field absent)*
- work_start: `06:00`
- work_end: `18:00`
- hourly_wager: `false`
- role: `member`

## 2. attendance — last 7 (sort date desc) for that user_id
| date | check_in_at (UTC) | ≈IST | late | late_minutes | method | checked_in_by | approval_status |
|---|---|---|---|---|---|---|---|
| 2026-10-09 | 03:51:51Z | 09:21 | **true** | **202** | geo | null | null |
| 2026-10-08 | 00:21:45Z | 05:51 | false | 0 | geo | null | null |
| 2026-10-07 | 04:01:00Z | 09:31 | **true** | **211** | geo | null | null |
| 2026-10-04 | 02:52:59Z | 08:22 | **true** | **142** | geo | null | null |
| 2026-10-03 | 03:42:58Z | 09:12 | **true** | **192** | geo | null | null |
| 2026-10-02 | 00:26:46Z | 05:56 | false | 0 | geo | null | null |
| 2026-10-01 | 00:28:24Z | 05:58 | false | 0 | geo | null | null |

Consistent with compute_late against work_start 06:00 + grace 0: check-ins before 06:00 IST → late=false; after → late=true with the right minute delta. The most recent record (Oct 9) is late=true/202.

## 3. config — db.config.findOne({id:'office'})
- late_grace_minutes: `0`
- default_work_start: `09:30` (note: member's own work_start 06:00 takes precedence, matching the computed values)
- timezone: `Asia/Kolkata`

## 4. camps active in last 7 days including this user
None. Two camps exist (`Agape Sat Sun Camp` end_date 2026-07-31; `Agape Spl camp` end_date 2026-06-26) — both **ended months ago** AND neither member_ids list contains `3c2538dc-...`. No camp override applies to Preethi.

## 5. Backend logs — POST /api/attendance/geo-toggle (last 24h, log cap)
Access logs are request-line only (`method path -> status ms`); they do **not** carry user_id or the response body, so the exact `late` field returned to Preethi cannot be read from logs. Observed: geo-toggle overwhelmingly `200 OK`, a couple of `400 Bad Request` (consistent with duplicate/invalid toggle attempts), no tracebacks/500s. The `late` value in the response payload is not observable here.

## Conclusion / where to look next (Code — not DB, not platform)
Because the DB stores `late=true` correctly (incl. the open session), the caption dropping "LATE" is downstream:
- Confirm `POST /api/attendance/geo-toggle` response body actually includes `late`/`late_minutes` for the **check-in** branch (not just reads them back on `GET /status`).
- Confirm the client reads the same field names from the geo-toggle response it uses for the caption, and that `formatCheckinCaption` receives a truthy `late` (type coercion / stale response object).
- Cannot be reproduced in a sandbox (needs live request/response + client), so this is a diagnosis from DB facts, not a reproduced fix.
