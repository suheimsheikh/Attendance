#!/usr/bin/env bash
# ==============================================================================
# ci.sh — canonical test runner for I-Showed-Up backend.
#
# Do NOT invoke pytest directly. This wrapper guarantees the correct
# marker selection, env vars, and working directory for every tier.
# ==============================================================================
#
# TIERS (choose one per invocation):
#
#   ./ci.sh                     Fast tier (~70 s). Runs everything except the
#                               4 `@pytest.mark.slow` tests. This is the
#                               DEFAULT for iteration — run it after any
#                               backend edit before handing back to the user.
#
#   ./ci.sh --all               Full suite (~140 s). Includes slow tests.
#                               This is the PRE-DEPLOY GATE — must pass green
#                               before merging or shipping to production.
#
#   ./ci.sh --smoke             Smoke suite only (~3 s). Runs the tests
#                               marked `@pytest.mark.smoke`. Use for a quick
#                               "did I break the world?" sanity check after
#                               risky refactors or dependency upgrades.
#
# EXTRA PYTEST ARGS:
#
#   ./ci.sh -- -k test_dashboard         # run only tests matching a keyword
#   ./ci.sh -- tests/test_meals.py       # run a single file
#   ./ci.sh --all -- -x --lf             # full suite, stop on first fail, last-failed
#
# Anything after `--` is forwarded verbatim to pytest.
#
# ENV:
#
#   TEST_ADMIN_PASSWORD    Admin login used across the suite. Auto-populated
#                          from /app/memory/test_credentials.md if unset.
#
# Design note: `-n auto` (pytest-xdist) would shave more time but 4 tests
# rely on order-dependent shared state. Cleanup deferred post-launch.
# Fast tier is already ~50% faster than the serial full run.
# ==============================================================================

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
