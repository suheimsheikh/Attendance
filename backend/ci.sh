#!/usr/bin/env bash
# ci.sh — fast iteration test runner for I-Showed-Up.
#
# Usage:
#   ./ci.sh                     # fast tier (~70 s, 4 slow tests excluded)
#   ./ci.sh --all               # full suite (~140 s, pre-deploy gate)
#   ./ci.sh --smoke             # 3-second smoke suite only
#   ./ci.sh -- <extra pytest>   # pass anything after `--` to pytest
#
# Design note: parallel (-n auto) shaves this down further but 4 tests
# fail under order-dependent shared state. Deferred until we clean those
# up. Fast tier is still ~50% faster than serial full.

set -euo pipefail
cd "$(dirname "$0")"

# Every test invocation needs the admin password. Read it once from
# /app/memory/test_credentials.md (source of truth for the fork agent)
# if not already set in the environment.
if [[ -z "${TEST_ADMIN_PASSWORD:-}" ]]; then
  export TEST_ADMIN_PASSWORD="Admin@12345"
fi

MODE="fast"
EXTRA=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)   MODE="all"; shift ;;
    --smoke) MODE="smoke"; shift ;;
    --)      shift; EXTRA=("$@"); break ;;
    *)       EXTRA+=("$1"); shift ;;
  esac
done

case "$MODE" in
  fast)
    echo "[ci.sh] Fast tier (\`not slow\`) — pre-deploy gate is \`--all\`."
    exec python -m pytest -m "not slow" -q "${EXTRA[@]}"
    ;;
  all)
    echo "[ci.sh] Full suite — safe for deploy."
    exec python -m pytest -q "${EXTRA[@]}"
    ;;
  smoke)
    echo "[ci.sh] Smoke suite only (~3 s)."
    exec python -m pytest -m smoke -q "${EXTRA[@]}"
    ;;
esac
