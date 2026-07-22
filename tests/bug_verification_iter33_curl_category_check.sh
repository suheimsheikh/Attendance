#!/usr/bin/env bash
set -euo pipefail

# Focused curl+jq proof for: config.empty_categories must not appear when
# db.categories has at least one row. Non-mutating; the opposite empty-branch is
# covered by /app/tests/bug_verification_iter33_data_quality.py.

API="${TEST_API_BASE:-http://localhost:8001/api}"
ENV_FILE="/app/backend/.env"

ADMIN_EMAIL=$(python - <<'PY'
from pathlib import Path
env = {}
for line in Path('/app/backend/.env').read_text().splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k,v=line.split('=',1); env[k]=v.strip().strip('"').strip("'")
print(env['ADMIN_SEED_EMAIL'])
PY
)
ADMIN_PASSWORD=$(python - <<'PY'
from pathlib import Path
env = {}
for line in Path('/app/backend/.env').read_text().splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k,v=line.split('=',1); env[k]=v.strip().strip('"').strip("'")
print(env['ADMIN_SEED_PASSWORD'])
PY
)
CATEGORY_COUNT=$(python - <<'PY'
from pathlib import Path
from pymongo import MongoClient
env = {}
for line in Path('/app/backend/.env').read_text().splitlines():
    if '=' in line and not line.strip().startswith('#'):
        k,v=line.split('=',1); env[k]=v.strip().strip('"').strip("'")
db = MongoClient(env['MONGO_URL'])[env['DB_NAME']]
print(db.categories.count_documents({}))
PY
)

TOKEN=$(curl -sS -X POST "$API/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.access_token')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "FAILED: admin login did not return access_token" >&2
  exit 1
fi

COUNT=$(curl -sS "$API/admin/data-quality" \
  -H "Authorization: Bearer $TOKEN" | jq '[.findings[]? | select(.code=="config.empty_categories")] | length')

echo "db.categories count=$CATEGORY_COUNT; config.empty_categories findings=$COUNT"
if [[ "$CATEGORY_COUNT" -ge 1 && "$COUNT" -ne 0 ]]; then
  echo "FAILED: config.empty_categories present despite db.categories >= 1" >&2
  exit 1
fi
echo "PASSED: config.empty_categories absent when db.categories has rows"