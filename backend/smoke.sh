#!/usr/bin/env bash
# Launch-day green light. Run from /app/backend BEFORE opening the app
# to real users on launch morning:
#
#   TEST_ADMIN_PASSWORD='<the real prod pw>' ./smoke.sh
#
# Exits 0 → safe to launch. Exits non-zero → hold; read the failure.
#
# Total wall time: ~3 seconds. Hits every critical endpoint on the
# live preview backend the same way a real browser would (via the
# public REACT_APP_BACKEND_URL).
set -euo pipefail

cd "$(dirname "$0")"

if [ -z "${TEST_ADMIN_PASSWORD:-}" ]; then
  echo "ERROR: set TEST_ADMIN_PASSWORD env var first."
  echo "  export TEST_ADMIN_PASSWORD='...'"
  exit 2
fi

python -m pytest -m smoke -q --tb=line "$@"
