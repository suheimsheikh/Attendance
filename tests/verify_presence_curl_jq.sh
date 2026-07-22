#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${TEST_BACKEND_URL:-https://attendance-portal-56.preview.emergentagent.com}"
API="${BASE_URL%/}/api"
STATE_FILE="/app/test_reports/ex_member_ui_seed_state.json"

if [[ -f "$STATE_FILE" ]]; then
  MEMBER_ID="$(jq -r '.member_id' "$STATE_FILE")"
  ORIG_LEAVING_DATE="$(jq -r '.orig_leaving_date // empty' "$STATE_FILE")"
else
  MEMBER_ID="${TEST_MEMBER_ID:?Set TEST_MEMBER_ID or seed via seed_ex_member_for_ui.py first}"
  ORIG_LEAVING_DATE="${ORIG_LEAVING_DATE:-}"
fi

TOKEN="$(curl -fsS -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@attendance.app","password":"Admin@12345"}' | jq -r '.access_token')"

curl -fsS -X PATCH "$API/members/$MEMBER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"leaving_date":"2020-01-01"}' >/tmp/verify_presence_patch.json

ROW="$(curl -fsS "$API/presence" -H "Authorization: Bearer $TOKEN" \
  | jq -c --arg id "$MEMBER_ID" '.members[] | select(.id == $id) | {id, full_name, leaving_date, status}')"

echo "$ROW" | jq .
ACTUAL="$(echo "$ROW" | jq -r '.leaving_date')"
if [[ "$ACTUAL" != "2020-01-01" ]]; then
  echo "FAIL: expected leaving_date=2020-01-01, got $ACTUAL" >&2
  exit 2
fi

if [[ -n "$ORIG_LEAVING_DATE" ]]; then
  RESTORE_PAYLOAD="$(jq -cn --arg d "$ORIG_LEAVING_DATE" '{leaving_date:$d}')"
else
  RESTORE_PAYLOAD='{"leaving_date":null}'
fi
curl -fsS -X PATCH "$API/members/$MEMBER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$RESTORE_PAYLOAD" >/tmp/verify_presence_restore.json

echo "PASS: /api/presence emitted leaving_date=2020-01-01 for $MEMBER_ID and restored original leaving_date."