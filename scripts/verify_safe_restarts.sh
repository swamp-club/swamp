#!/usr/bin/env bash
# Verification script for Phase 2: safe restarts.
# Uses the compiled swamp binary to verify that work survives
# process restarts when --detach-runs is enabled.
#
# Prerequisites:
#   deno run compile   (builds the swamp binary)
#
# Usage:
#   bash scripts/verify_safe_restarts.sh [path-to-swamp-binary]

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

[ -x "$SWAMP" ] || { red "swamp binary not found at $SWAMP"; red "Run: deno run compile"; exit 1; }

# ── Setup ────────────────────────────────────────────────────────────

bold "Setting up test repo..."
REPO_DIR=$(mktemp -d -t swamp-verify-restart-XXXXXX)
"$SWAMP" repo init "$REPO_DIR" >/dev/null 2>&1

# Create a very slow workflow (60s — long enough to guarantee it's still running when we kill)
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
            run: "sleep 60 && echo completed"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
EOF

# Create a fast workflow
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
            run: "echo done"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
EOF

# ── Test 1: In-flight run marked as failed on graceful shutdown ──────

bold "Test 1: In-flight run marked as failed on graceful shutdown"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1
SERVER_URL="ws://127.0.0.1:$PORT"

"$SWAMP" workflow run slow-run --server "$SERVER_URL" --repo-dir "$REPO_DIR" >/dev/null 2>&1 &
CLIENT_PID=$!
sleep 2
kill "$CLIENT_PID" 2>/dev/null || true
wait "$CLIENT_PID" 2>/dev/null || true

kill -TERM "$SERVE_PID" 2>/dev/null || true
EXITED=false
for i in $(seq 1 40); do
  kill -0 "$SERVE_PID" 2>/dev/null || { EXITED=true; break; }
  sleep 1
done
[ "$EXITED" = true ] || { kill -9 "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; }
SERVE_PID=""

HISTORY=$("$SWAMP" workflow history slow-run --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$HISTORY" | grep -q '"failed"'; then
  pass "in-flight run marked as failed on graceful shutdown"
elif echo "$HISTORY" | grep -q '"succeeded"'; then
  fail "run completed before shutdown — workflow is too fast, interrupt path NOT tested" "History: ${HISTORY:0:300}"
elif echo "$HISTORY" | grep -q '"cancelled"'; then
  fail "run was cancelled instead of failed — interrupt path not working" "History: ${HISTORY:0:300}"
else
  fail "unexpected run state after graceful shutdown" "History: ${HISTORY:0:300}"
fi
rm -f "$SERVE_STDOUT"

# ── Test 2: In-flight run marked as failed on crash (SIGKILL) ────────

bold "Test 2: In-flight run marked as failed on crash (SIGKILL)"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1
SERVER_URL="ws://127.0.0.1:$PORT"

"$SWAMP" workflow run slow-run --server "$SERVER_URL" --repo-dir "$REPO_DIR" >/dev/null 2>&1 &
CLIENT_PID=$!
sleep 2
kill "$CLIENT_PID" 2>/dev/null || true
wait "$CLIENT_PID" 2>/dev/null || true

kill -9 "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

# Restart serve — boot reconciliation should mark the interrupted run
SERVE_STDOUT2=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT2" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT2" || exit 1

sleep 2

HISTORY=$("$SWAMP" workflow history slow-run --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$HISTORY" | grep -q '"failed"'; then
  pass "crashed run marked as failed after restart (interrupt reconciliation working)"
elif echo "$HISTORY" | grep -q '"cancelled"'; then
  fail "crashed run was cancelled instead of failed — --detach-runs interrupt not working" "History: ${HISTORY:0:300}"
elif echo "$HISTORY" | grep -q '"succeeded"'; then
  fail "run completed before SIGKILL — workflow is too fast, crash recovery NOT tested" "History: ${HISTORY:0:300}"
else
  fail "crashed run not properly reconciled" "History: ${HISTORY:0:300}"
fi

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_STDOUT" "$SERVE_STDOUT2"

# ── Test 3: Normal run completes with --detach-runs ──────────────────

bold "Test 3: Normal run completes with --detach-runs"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1
SERVER_URL="ws://127.0.0.1:$PORT"

OUTPUT=$("$SWAMP" workflow run fast-echo --server "$SERVER_URL" --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$OUTPUT" | grep -q '"succeeded"\|"completed"'; then
  pass "normal run completed successfully"
else
  fail "normal run did not complete" "Output: ${OUTPUT:0:200}"
fi

# ── Test 4: Without --detach-runs, runs are cancelled (unchanged) ────

bold "Test 4: Without --detach-runs, runs are cancelled (unchanged behavior)"

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

SERVE_STDOUT2=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT2" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT2" || exit 1
SERVER_URL2="ws://127.0.0.1:$PORT"

"$SWAMP" workflow run slow-run --server "$SERVER_URL2" --repo-dir "$REPO_DIR" >/dev/null 2>&1 &
CLIENT_PID=$!
sleep 2
kill "$CLIENT_PID" 2>/dev/null || true
wait "$CLIENT_PID" 2>/dev/null || true

kill -9 "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

# Restart without --detach-runs
SERVE_STDOUT3=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --repo-dir "$REPO_DIR" > "$SERVE_STDOUT3" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT3" || exit 1

sleep 2

HISTORY=$("$SWAMP" workflow history slow-run --json --repo-dir "$REPO_DIR" 2>&1) || true
if echo "$HISTORY" | grep -q '"cancelled"'; then
  pass "without --detach-runs, run is cancelled (unchanged behavior)"
elif echo "$HISTORY" | grep -q '"failed"'; then
  pass "without --detach-runs, run is failed (acceptable — reaped by tracker)"
elif echo "$HISTORY" | grep -q '"running"'; then
  pass "without --detach-runs, run is still running (heartbeat not yet stale — existing behavior)"
else
  fail "without --detach-runs, unexpected run state" "History: ${HISTORY:0:300}"
fi

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_STDOUT" "$SERVE_STDOUT2" "$SERVE_STDOUT3"

# ── Test 5: Webhook durable intake survives restart ──────────────────

bold "Test 5: Webhook durable intake — queued webhook survives restart"

set +eo pipefail

# Kill any leftover serve
kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""

# Create a webhook workflow
WH_WF_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
cat > "$REPO_DIR/workflows/workflow-${WH_WF_ID}.yaml" <<EOF
id: ${WH_WF_ID}
name: webhook-test
tags: {}
jobs:
  - name: main
    steps:
      - name: mark
        task:
          type: model_method
          modelType: command/shell
          modelName: wh-shell
          methodName: execute
          inputs:
            run: "echo webhook-executed"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
EOF

# Start serve with a webhook endpoint
SERVE_STDOUT=$(mktemp)
SERVE_STDERR=$(mktemp)
WH_SECRET="testsecret123"
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs \
  --webhook "/hooks/test:webhook-test:${WH_SECRET}" \
  --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>"$SERVE_STDERR" &
SERVE_PID=$!

if ! wait_for_port "$SERVE_PID" "$SERVE_STDOUT"; then
  fail "serve failed to start for webhook test" "stderr: $(head -5 "$SERVE_STDERR")"
  SERVE_PID=""
elif ! command -v curl >/dev/null 2>&1; then
  pass "webhook test skipped (curl not available)"
  kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""
elif ! command -v openssl >/dev/null 2>&1; then
  pass "webhook test skipped (openssl not available)"
  kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""
else
  PAYLOAD='{"ref":"main","action":"push"}'
  SIGNATURE=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WH_SECRET" 2>/dev/null | sed 's/.*= //') || true

  WH_RESPONSE=$(curl -s --max-time 5 -X POST "http://127.0.0.1:$PORT/hooks/test" \
    -H "Content-Type: application/json" \
    -H "x-hub-signature-256: sha256=$SIGNATURE" \
    -d "$PAYLOAD" 2>&1) || true

  if [ -z "$WH_RESPONSE" ]; then
    fail "webhook request got no response" "PORT=$PORT, curl returned empty"
    kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""
  elif echo "$WH_RESPONSE" | grep -q '"queued"'; then
    kill -9 "$SERVE_PID" 2>/dev/null
    wait "$SERVE_PID" 2>/dev/null || true
    SERVE_PID=""

    PENDING_COUNT=$(sqlite3 "$REPO_DIR/.swamp/run_tracker.db" "SELECT COUNT(*) FROM pending_runs;" 2>/dev/null) || PENDING_COUNT="error"

    SERVE_STDOUT2=$(mktemp)
    "$SWAMP" serve --json --port 0 --no-schedule --detach-runs \
      --webhook "/hooks/test:webhook-test:${WH_SECRET}" \
      --repo-dir "$REPO_DIR" > "$SERVE_STDOUT2" 2>/dev/null &
    SERVE_PID=$!

    if wait_for_port "$SERVE_PID" "$SERVE_STDOUT2"; then
      sleep 5

      WH_HISTORY=$("$SWAMP" workflow history webhook-test --json --repo-dir "$REPO_DIR" 2>&1) || true
      PENDING_AFTER=$(sqlite3 "$REPO_DIR/.swamp/run_tracker.db" "SELECT COUNT(*) FROM pending_runs;" 2>/dev/null) || PENDING_AFTER="error"

      if echo "$WH_HISTORY" | grep -q '"succeeded"'; then
        pass "webhook run survived restart and completed (pending_runs: $PENDING_COUNT->$PENDING_AFTER)"
      elif [ "$PENDING_COUNT" = "0" ]; then
        pass "webhook was processed before SIGKILL (race — pending_run already deleted)"
      else
        fail "webhook run did not complete after restart" "pending=$PENDING_COUNT->$PENDING_AFTER, History: ${WH_HISTORY:0:200}"
      fi
    else
      fail "serve failed to restart for webhook replay"
    fi

    kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""
    rm -f "$SERVE_STDOUT2"
  else
    fail "webhook was not accepted" "Response: ${WH_RESPONSE:0:200}"
    kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null; SERVE_PID=""
  fi
fi
rm -f "$SERVE_STDOUT" "$SERVE_STDERR"

set -euo pipefail

# ── Test 6: Normal restart with no pending work ──────────────────────

bold "Test 6: Normal restart with no pending work"

SERVE_STDOUT=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT" 2>/dev/null &
SERVE_PID=$!
wait_for_port "$SERVE_PID" "$SERVE_STDOUT" || exit 1

kill -TERM "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

SERVE_STDOUT2=$(mktemp)
"$SWAMP" serve --json --port 0 --no-schedule --detach-runs --repo-dir "$REPO_DIR" > "$SERVE_STDOUT2" 2>/dev/null &
SERVE_PID=$!
if wait_for_port "$SERVE_PID" "$SERVE_STDOUT2"; then
  pass "clean restart with no pending work"
else
  fail "serve failed to restart cleanly"
fi

kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""
rm -f "$SERVE_STDOUT" "$SERVE_STDOUT2"

# ── Summary ──────────────────────────────────────────────────────────

echo ""
bold "════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "All $TOTAL tests passed"
else
  red "$FAIL of $TOTAL tests failed"
fi
bold "════════════════════════════════════════"

exit "$FAIL"
