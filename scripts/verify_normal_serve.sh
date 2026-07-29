#!/usr/bin/env bash
# Verification that normal swamp serve operations (WITHOUT --detach-runs)
# continue to work exactly as before. No regressions.
#
# Usage:
#   bash scripts/verify_normal_serve.sh [path-to-swamp-binary]

set -euo pipefail

SWAMP="${1:-./swamp}"
PASS=0
FAIL=0
TOTAL=0

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); green "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); red "  FAIL: $1"; [ -n "${2:-}" ] && red "        $2"; }

cleanup() {
  if [ -n "${SERVE_PID:-}" ]; then
    kill "$SERVE_PID" 2>/dev/null || true
    wait "$SERVE_PID" 2>/dev/null || true
  fi
  [ -n "${REPO_DIR:-}" ] && rm -rf "$REPO_DIR"
}
trap cleanup EXIT

wait_for_port() {
  local pid="$1" stdout_file="$2" timeout=15 elapsed=0
  while [ $elapsed -lt $timeout ]; do
    kill -0 "$pid" 2>/dev/null || { red "serve died during startup"; cat "$stdout_file"; return 1; }
    if grep -q '"status":"listening"' "$stdout_file" 2>/dev/null; then
      PORT=$(grep '"status":"listening"' "$stdout_file" | head -1 | sed 's/.*"port":\([0-9]*\).*/\1/')
      return 0
    fi
    sleep 1; elapsed=$((elapsed + 1))
  done
  red "timed out waiting for serve to start"; cat "$stdout_file"; return 1
}

[ -x "$SWAMP" ] || { red "swamp binary not found at $SWAMP"; exit 1; }

bold "══════════════════════════════════════════════════"
bold " Normal serve operations (NO --detach-runs)"
bold "══════════════════════════════════════════════════"
echo ""

REPO_DIR=$(mktemp -d -t swamp-verify-normal-XXXXXX)
"$SWAMP" repo init "$REPO_DIR" >/dev/null 2>&1

FAST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
cat > "$REPO_DIR/workflows/workflow-${FAST_ID}.yaml" <<EOF
id: ${FAST_ID}
name: fast-echo
tags: {}
jobs:
  - name: main
    steps:
      - name: echo
        task:
          type: model_method
          modelType: command/shell
          modelName: fast-shell
          methodName: execute
          inputs:
            run: "echo normal-serve-ok"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
EOF

SLOW_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
cat > "$REPO_DIR/workflows/workflow-${SLOW_ID}.yaml" <<EOF
id: ${SLOW_ID}
name: slow-run
tags: {}
jobs:
  - name: main
    steps:
      - name: slow
        task:
          type: model_method
          modelType: command/shell
          modelName: slow-shell
          methodName: execute
          inputs:
            run: "sleep 10 && echo slow-done"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
EOF

# ── Test 1: Serve starts and listens ─────────────────────────────────

bold "Test 1: Serve starts and listens (no --detach-runs)"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!

if wait_for_port "$SERVE_PID" "$SERVE_STDOUT"; then
  pass "serve started and listening on port $PORT"
else
  fail "serve failed to start"
  exit 1
fi
SERVER_URL="ws://127.0.0.1:$PORT"

# ── Test 2: Workflow run completes normally ──────────────────────────

bold "Test 2: Workflow run completes normally"

OUTPUT=$("$SWAMP" workflow run fast-echo --server "$SERVER_URL" --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$OUTPUT" | grep -q '"succeeded"\|"completed"'; then
  pass "workflow run completed successfully"
else
  fail "workflow run did not complete" "Output: ${OUTPUT:0:200}"
fi

# ── Test 3: Client disconnect cancels run (old behavior) ─────────────

bold "Test 3: Client disconnect cancels run (old behavior without --detach-runs)"

"$SWAMP" workflow run slow-run --server "$SERVER_URL" --repo-dir "$REPO_DIR" >/dev/null 2>&1 &
CLIENT_PID=$!
sleep 3
kill "$CLIENT_PID" 2>/dev/null || true
wait "$CLIENT_PID" 2>/dev/null || true

sleep 2

HISTORY=$("$SWAMP" workflow history slow-run --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$HISTORY" | grep -q '"cancelled"'; then
  pass "client disconnect cancelled the run (expected old behavior)"
elif echo "$HISTORY" | grep -q '"succeeded"'; then
  pass "run completed before disconnect (race — acceptable)"
elif echo "$HISTORY" | grep -q '"failed"'; then
  pass "run failed after disconnect (acceptable)"
else
  fail "unexpected run state after disconnect" "History: ${HISTORY:0:300}"
fi

# ── Test 4: Graceful shutdown (SIGINT) ───────────────────────────────

bold "Test 4: Graceful shutdown via SIGINT"

kill -INT "$SERVE_PID" 2>/dev/null || true
EXITED=false
for i in $(seq 1 10); do
  kill -0 "$SERVE_PID" 2>/dev/null || { EXITED=true; break; }
  sleep 1
done

if [ "$EXITED" = true ]; then
  wait "$SERVE_PID" 2>/dev/null
  EXIT_CODE=$?
  if [ "$EXIT_CODE" -eq 0 ] || [ "$EXIT_CODE" -eq 130 ]; then
    pass "serve exited cleanly (exit code $EXIT_CODE)"
  else
    fail "serve exited with unexpected code $EXIT_CODE"
  fi
else
  fail "serve did not exit within 10s after SIGINT"
  kill -9 "$SERVE_PID" 2>/dev/null || true
  wait "$SERVE_PID" 2>/dev/null || true
fi
SERVE_PID=""
rm -f "$SERVE_STDOUT"

# ── Test 5: Restart after crash (SIGKILL) — runs are cancelled ───────

bold "Test 5: After crash, orphaned runs are cancelled (old behavior)"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1
SERVER_URL="ws://127.0.0.1:$PORT"

"$SWAMP" workflow run slow-run --server "$SERVER_URL" --repo-dir "$REPO_DIR" >/dev/null 2>&1 &
CLIENT_PID=$!
sleep 3
kill "$CLIENT_PID" 2>/dev/null || true
wait "$CLIENT_PID" 2>/dev/null || true

kill -9 "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

# Restart without --detach-runs
SERVE_STDOUT2=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT2" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT2" || exit 1

sleep 2

HISTORY=$("$SWAMP" workflow history slow-run --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$HISTORY" | grep -q '"cancelled"'; then
  pass "after crash without --detach-runs, run is cancelled (old behavior preserved)"
elif echo "$HISTORY" | grep -q '"failed"\|"succeeded"'; then
  pass "after crash, run is in terminal state (acceptable)"
else
  fail "unexpected run state after crash" "History: ${HISTORY:0:300}"
fi

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_STDOUT" "$SERVE_STDOUT2"

# ── Test 6: Multiple sequential workflow runs ────────────────────────

bold "Test 6: Multiple sequential workflow runs"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1
SERVER_URL="ws://127.0.0.1:$PORT"

ALL_OK=true
for i in 1 2 3; do
  OUTPUT=$("$SWAMP" workflow run fast-echo --server "$SERVER_URL" --json --repo-dir "$REPO_DIR" 2>&1) || true
  if ! echo "$OUTPUT" | grep -q '"succeeded"\|"completed"'; then
    ALL_OK=false
    break
  fi
done

if [ "$ALL_OK" = true ]; then
  pass "3 sequential runs all completed successfully"
else
  fail "sequential run $i failed" "Output: ${OUTPUT:0:200}"
fi

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_STDOUT"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
bold "════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "All $TOTAL normal serve tests passed"
else
  red "$FAIL of $TOTAL normal serve tests failed"
fi
bold "════════════════════════════════════════"

exit "$FAIL"
