#!/usr/bin/env bash
# Queue visibility smoke tests — verifies step_queued events, swamp worker queue
# CLI, and pending-dispatch data model with the compiled binary.
#
# Proves: step_queued appears in log and json output, swamp worker queue shows
# waiting steps and empties after dispatch, pending-dispatch data transitions
# through waiting→dispatched and waiting→timed_out.
#
# Usage: ./tests/fleet-smoke/verify-queue-visibility.sh
# Requires: Docker, jq, the compiled swamp binary in the repo root.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE="swamp-smoke:local"
REPO_DIR=""
ORCHESTRATOR_CID=""
PASS=0
FAIL=0

# ── Cleanup ──────────────────────────────────────────────────────────
cleanup() {
  [ -n "${ORCHESTRATOR_CID:-}" ] && docker rm -f "$ORCHESTRATOR_CID" 2>/dev/null || true
  [ -n "${REPO_DIR:-}" ] && rm -rf "$REPO_DIR" || true
}
trap cleanup EXIT

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

stop_containers() {
  if [ -n "${ORCHESTRATOR_CID:-}" ]; then
    echo "  --- orchestrator logs ---"
    docker logs "$ORCHESTRATOR_CID" 2>&1 | grep -v '^\[0m\[38;5;245' | tail -30
    echo "  --- end logs ---"
    docker rm -f "$ORCHESTRATOR_CID" 2>/dev/null || true
  fi
  ORCHESTRATOR_CID=""
}

wait_for_serve() {
  local cid="$1"
  local max_wait="${2:-15}"
  local elapsed=0
  until docker exec "$cid" \
    swamp worker list --server ws://127.0.0.1:9090 --json 2>/dev/null; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$((max_wait * 2))" ]; then
      echo "  ERROR: orchestrator did not start within ${max_wait}s"
      docker logs "$cid" 2>&1 | tail -20
      return 1
    fi
  done
  return 0
}

# ── Build ────────────────────────────────────────────────────────────
DOCKER_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo "x86_64")
case "$DOCKER_ARCH" in
  aarch64|arm64) DENO_TARGET="aarch64-unknown-linux-gnu" ;;
  *)             DENO_TARGET="x86_64-unknown-linux-gnu" ;;
esac

echo "==> Compiling Linux binary (target: $DENO_TARGET)..."
(cd "$REPO_ROOT" && deno task compile --target "$DENO_TARGET")

echo "==> Building Docker image..."
docker build -t "$IMAGE" "$REPO_ROOT"

echo "==> Recompiling host binary..."
(cd "$REPO_ROOT" && deno task compile)

# ── Bootstrap repo ───────────────────────────────────────────────────
echo "==> Bootstrapping test repo..."
REPO_DIR=$(mktemp -d)
"$REPO_ROOT/swamp" init "$REPO_DIR" --quiet
"$REPO_ROOT/swamp" vault create local_encryption local-enc \
  --repo-dir "$REPO_DIR" --config '{"auto_generate": true}'

"$REPO_ROOT/swamp" model create command/shell smoke-echo \
  --repo-dir "$REPO_DIR" --json >/dev/null

create_workflow() {
  local name="$1"
  "$REPO_ROOT/swamp" workflow create "$name" \
    --repo-dir "$REPO_DIR" --json | jq -r '.path'
}

# Workflow: placed step with labels (reused across scenarios 1-4)
WF1_PATH=$(create_workflow smoke-placed)
WF1_ID=$(basename "$WF1_PATH" .yaml | sed 's/workflow-//')
cat > "$REPO_DIR/workflows/$(basename "$WF1_PATH")" <<YAML
id: $WF1_ID
name: smoke-placed
jobs:
  - name: main
    steps:
      - name: echo-step
        labels:
          tier: smoke
        task:
          type: model_method
          modelIdOrName: smoke-echo
          methodName: execute
          inputs:
            run: "echo hello-from-worker"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
YAML

# Workflow: unmatched labels (for timeout scenario 5)
WF2_PATH=$(create_workflow smoke-unmatched)
WF2_ID=$(basename "$WF2_PATH" .yaml | sed 's/workflow-//')
cat > "$REPO_DIR/workflows/$(basename "$WF2_PATH")" <<YAML
id: $WF2_ID
name: smoke-unmatched
jobs:
  - name: main
    steps:
      - name: gpu-step
        labels:
          gpu: "true"
        task:
          type: model_method
          modelIdOrName: smoke-echo
          methodName: execute
          inputs:
            run: "echo should-not-run"
        dependsOn: []
        weight: 0
        allowFailure: false
    dependsOn: []
    weight: 0
version: 1
YAML

# Mint tokens (one per scenario that connects a worker)
TOKEN=$("$REPO_ROOT/swamp" worker token create vis-worker-1 \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')
TOKEN2=$("$REPO_ROOT/swamp" worker token create vis-worker-2 \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')
TOKEN3=$("$REPO_ROOT/swamp" worker token create vis-worker-3 \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')
TOKEN4=$("$REPO_ROOT/swamp" worker token create vis-worker-4 \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: failed to mint worker token"
  exit 1
fi
echo "  Tokens minted."

# ── Scenario 1: step_queued in log output ────────────────────────────
echo ""
echo "==> Scenario 1: step_queued event in log-mode output"

ORCHESTRATOR_CID=$(docker run -d --name "orch-vis1-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow in background, capture output to a file inside the container
docker exec "$ORCHESTRATOR_CID" sh -c \
  'swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --log \
   > /tmp/wf-log-output.txt 2>&1 &'
sleep 2

# Check for the queued message before connecting a worker
LOG_CONTENT=$(docker exec "$ORCHESTRATOR_CID" cat /tmp/wf-log-output.txt 2>/dev/null || echo "")
if echo "$LOG_CONTENT" | grep -qi "waiting for a worker"; then
  pass "step_queued event visible in log output while queued"
else
  fail "step_queued event not found in log output"
  echo "  Output: $(echo "$LOG_CONTENT" | head -5)"
fi

# Connect worker to let it complete
docker exec -d "$ORCHESTRATOR_CID" \
  swamp worker connect ws://127.0.0.1:9090 --token "$TOKEN" --label tier=smoke
sleep 5

# Verify the workflow completed (check the output for a completion indicator)
FINAL_LOG=$(docker exec "$ORCHESTRATOR_CID" cat /tmp/wf-log-output.txt 2>/dev/null || echo "")
if echo "$FINAL_LOG" | grep -qi "completed\|succeeded"; then
  pass "workflow completed after worker connected"
else
  fail "workflow did not complete after worker connected"
  echo "  Output tail: $(echo "$FINAL_LOG" | tail -5)"
fi

stop_containers

# ── Scenario 2: step_queued in JSON output ───────────────────────────
echo ""
echo "==> Scenario 2: step_queued event in JSON-mode output"

ORCHESTRATOR_CID=$(docker run -d --name "orch-vis2-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow with --json, capture output inside container
docker exec "$ORCHESTRATOR_CID" sh -c \
  'swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --json \
   > /tmp/wf-json-output.txt 2>&1 &'
sleep 1

# Connect worker after a short delay
docker exec -d "$ORCHESTRATOR_CID" \
  swamp worker connect ws://127.0.0.1:9090 --token "$TOKEN2" --label tier=smoke
sleep 5

# Check for step_queued event in JSON output
JSON_OUTPUT=$(docker exec "$ORCHESTRATOR_CID" cat /tmp/wf-json-output.txt 2>/dev/null || echo "")
if echo "$JSON_OUTPUT" | grep -o '{[^}]*}' | jq -e 'select(.kind == "step_queued")' >/dev/null 2>&1; then
  pass "step_queued event found in JSON output"
else
  # Try line-by-line (JSON stream format)
  FOUND_QUEUED=false
  while IFS= read -r line; do
    if echo "$line" | jq -e 'select(.kind == "step_queued")' >/dev/null 2>&1; then
      FOUND_QUEUED=true
      break
    fi
  done <<< "$JSON_OUTPUT"
  if [ "$FOUND_QUEUED" = true ]; then
    pass "step_queued event found in JSON output (stream format)"
  else
    fail "step_queued event not found in JSON output"
    echo "  Output head: $(echo "$JSON_OUTPUT" | head -5)"
  fi
fi

# Verify requirement field is present
REQUIREMENT=$(echo "$JSON_OUTPUT" | grep -o '{[^}]*step_queued[^}]*}' | head -1 | jq -r '.requirement // empty' 2>/dev/null || echo "")
if [ -n "$REQUIREMENT" ]; then
  pass "step_queued event has requirement field: $REQUIREMENT"
else
  fail "step_queued event missing requirement field"
fi

stop_containers

# ── Scenario 3: swamp worker queue CLI ───────────────────────────────
echo ""
echo "==> Scenario 3: swamp worker queue shows/empties correctly"

ORCHESTRATOR_CID=$(docker run -d --name "orch-vis3-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow — it will queue (no workers yet)
docker exec "$ORCHESTRATOR_CID" sh -c \
  'swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --log \
   > /tmp/wf-queue.txt 2>&1 &'
sleep 2

# Check worker queue (log mode)
QUEUE_LOG=$(docker exec "$ORCHESTRATOR_CID" \
  swamp worker queue --server ws://127.0.0.1:9090 2>&1 || true)
if echo "$QUEUE_LOG" | grep -qi "tier=smoke\|echo-step\|REQUIREMENT"; then
  pass "swamp worker queue shows waiting step"
else
  fail "swamp worker queue did not show waiting step"
  echo "  Output: $QUEUE_LOG"
fi

# Check worker queue (json mode)
QUEUE_JSON=$(docker exec "$ORCHESTRATOR_CID" \
  swamp worker queue --server ws://127.0.0.1:9090 --json 2>&1 || true)
QUEUE_COUNT=$(echo "$QUEUE_JSON" | jq 'length' 2>/dev/null || echo "0")
if [ "$QUEUE_COUNT" -gt 0 ]; then
  pass "swamp worker queue --json returns non-empty array ($QUEUE_COUNT items)"
else
  fail "swamp worker queue --json returned empty or invalid"
  echo "  Output: $QUEUE_JSON"
fi

# Verify JSON fields
FIRST_ITEM_FIELDS=$(echo "$QUEUE_JSON" | jq '.[0] | keys' 2>/dev/null || echo "[]")
if echo "$FIRST_ITEM_FIELDS" | jq -e 'contains(["queueId", "requirement", "stepName"])' >/dev/null 2>&1; then
  pass "queue JSON items have queueId, requirement, stepName fields"
else
  fail "queue JSON items missing expected fields"
  echo "  Fields: $FIRST_ITEM_FIELDS"
fi

# Connect worker, wait for completion
docker exec -d "$ORCHESTRATOR_CID" \
  swamp worker connect ws://127.0.0.1:9090 --token "$TOKEN3" --label tier=smoke
sleep 5

# Queue should now be empty
QUEUE_AFTER=$(docker exec "$ORCHESTRATOR_CID" \
  swamp worker queue --server ws://127.0.0.1:9090 2>&1 || true)
if echo "$QUEUE_AFTER" | grep -qi "no steps\|currently queued"; then
  pass "swamp worker queue empty after dispatch (log mode)"
else
  fail "swamp worker queue not empty after dispatch"
  echo "  Output: $QUEUE_AFTER"
fi

QUEUE_AFTER_JSON=$(docker exec "$ORCHESTRATOR_CID" \
  swamp worker queue --server ws://127.0.0.1:9090 --json 2>&1 || true)
QUEUE_AFTER_COUNT=$(echo "$QUEUE_AFTER_JSON" | jq 'length' 2>/dev/null || echo "-1")
if [ "$QUEUE_AFTER_COUNT" -eq 0 ]; then
  pass "swamp worker queue --json empty after dispatch"
else
  fail "swamp worker queue --json not empty after dispatch (count: $QUEUE_AFTER_COUNT)"
fi

stop_containers

# ── Scenario 4: pending-dispatch data transitions ────────────────────
echo ""
echo "==> Scenario 4: pending-dispatch data query (waiting → dispatched)"

ORCHESTRATOR_CID=$(docker run -d --name "orch-vis4-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow — it will queue
docker exec "$ORCHESTRATOR_CID" sh -c \
  'swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --log \
   > /tmp/wf-data.txt 2>&1 &'
sleep 2

# Query for waiting pending-dispatch records
WAITING_DATA=$(docker exec "$ORCHESTRATOR_CID" \
  swamp data query 'modelType == "swamp/pending-dispatch" && attributes.state == "waiting"' \
  --server ws://127.0.0.1:9090 --json 2>&1 || true)
WAITING_COUNT=$(echo "$WAITING_DATA" | jq 'length' 2>/dev/null || echo "0")
if [ "$WAITING_COUNT" -gt 0 ]; then
  pass "pending-dispatch record found in waiting state ($WAITING_COUNT records)"
else
  fail "no pending-dispatch records in waiting state"
  echo "  Output: $(echo "$WAITING_DATA" | head -3)"
fi

# Connect worker, wait for completion
docker exec -d "$ORCHESTRATOR_CID" \
  swamp worker connect ws://127.0.0.1:9090 --token "$TOKEN4" --label tier=smoke
sleep 5

# Query for dispatched records
DISPATCHED_DATA=$(docker exec "$ORCHESTRATOR_CID" \
  swamp data query 'modelType == "swamp/pending-dispatch" && attributes.state == "dispatched"' \
  --server ws://127.0.0.1:9090 --json 2>&1 || true)
DISPATCHED_COUNT=$(echo "$DISPATCHED_DATA" | jq 'length' 2>/dev/null || echo "0")
if [ "$DISPATCHED_COUNT" -gt 0 ]; then
  pass "pending-dispatch record transitioned to dispatched state"
else
  fail "no pending-dispatch records in dispatched state after worker connected"
  echo "  Output: $(echo "$DISPATCHED_DATA" | head -3)"
fi

stop_containers

# ── Scenario 5: timeout creates timed_out record ────────────────────
echo ""
echo "==> Scenario 5: timeout creates timed_out pending-dispatch"

ORCHESTRATOR_CID=$(docker run -d --name "orch-vis5-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 5s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow with unmatched labels — it will time out
docker exec "$ORCHESTRATOR_CID" \
  swamp workflow run smoke-unmatched --server ws://127.0.0.1:9090 --log 2>&1 || true
sleep 1

# Query for timed_out records
TIMEDOUT_DATA=$(docker exec "$ORCHESTRATOR_CID" \
  swamp data query 'modelType == "swamp/pending-dispatch" && attributes.state == "timed_out"' \
  --server ws://127.0.0.1:9090 --json 2>&1 || true)
TIMEDOUT_COUNT=$(echo "$TIMEDOUT_DATA" | jq 'length' 2>/dev/null || echo "0")
if [ "$TIMEDOUT_COUNT" -gt 0 ]; then
  pass "pending-dispatch record transitioned to timed_out state"
else
  fail "no pending-dispatch records in timed_out state after timeout"
  echo "  Output: $(echo "$TIMEDOUT_DATA" | head -3)"
fi

stop_containers

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "==> Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
