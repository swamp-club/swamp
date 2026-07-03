#!/usr/bin/env bash
# Elastic queueing smoke tests — exercises the compiled swamp binary
# end-to-end with Docker containers acting as orchestrator and worker.
#
# Proves: --queue-timeout flag works, queue-on-empty waits for enroll,
# timeout fires with placement description, per-step queueTimeout
# overrides serve default, and wake-on-enroll is event-driven (not polled).
#
# Usage: ./tests/fleet-smoke/verify-queueing.sh
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
# Detect the Docker platform's architecture for cross-compilation
DOCKER_ARCH=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo "x86_64")
case "$DOCKER_ARCH" in
  aarch64|arm64) DENO_TARGET="aarch64-unknown-linux-gnu" ;;
  *)             DENO_TARGET="x86_64-unknown-linux-gnu" ;;
esac

echo "==> Compiling Linux binary (target: $DENO_TARGET)..."
(cd "$REPO_ROOT" && deno task compile --target "$DENO_TARGET")

echo "==> Building Docker image..."
docker build -t "$IMAGE" "$REPO_ROOT"

# Recompile for the host so we can bootstrap the repo locally
echo "==> Recompiling host binary..."
(cd "$REPO_ROOT" && deno task compile)

# ── Bootstrap repo ───────────────────────────────────────────────────
echo "==> Bootstrapping test repo..."
REPO_DIR=$(mktemp -d)
"$REPO_ROOT/swamp" init "$REPO_DIR" --quiet
"$REPO_ROOT/swamp" vault create local_encryption local-enc \
  --repo-dir "$REPO_DIR" --config '{"auto_generate": true}'

# Create a shell model for the smoke tests
"$REPO_ROOT/swamp" model create command/shell smoke-echo \
  --repo-dir "$REPO_DIR" --json >/dev/null

# Helper: create a workflow and return its YAML path
create_workflow() {
  local name="$1"
  "$REPO_ROOT/swamp" workflow create "$name" \
    --repo-dir "$REPO_DIR" --json | jq -r '.path'
}

# Workflow 1: placed step with labels
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

# Workflow 2: unmatched labels (for timeout test)
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

# Workflow 3: per-step queueTimeout override
WF3_PATH=$(create_workflow smoke-step-timeout)
WF3_ID=$(basename "$WF3_PATH" .yaml | sed 's/workflow-//')
cat > "$REPO_DIR/workflows/$(basename "$WF3_PATH")" <<YAML
id: $WF3_ID
name: smoke-step-timeout
jobs:
  - name: main
    steps:
      - name: short-timeout-step
        labels:
          gpu: "true"
        queueTimeout: 3
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

# Mint worker tokens (one per scenario that needs a worker)
TOKEN=$("$REPO_ROOT/swamp" worker token create smoke-worker \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')
TOKEN2=$("$REPO_ROOT/swamp" worker token create smoke-worker-2 \
  --duration 10m --repo-dir "$REPO_DIR" --json | jq -r '.token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "ERROR: failed to mint worker token"
  exit 1
fi
echo "  Tokens minted: ${TOKEN:0:20}... ${TOKEN2:0:20}..."

# ── Scenario 1: queue-on-empty → enroll → complete ──────────────────
echo ""
echo "==> Scenario 1: queue-on-empty, dispatch on enroll"

ORCHESTRATOR_CID=$(docker run -d --name "orch-s1-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow in background — it should queue, not fail
docker exec "$ORCHESTRATOR_CID" \
  swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --log 2>&1 &
RUN_PID=$!

sleep 2
if ! kill -0 "$RUN_PID" 2>/dev/null; then
  fail "workflow exited before worker enrolled (old fail-fast behavior)"
  stop_containers
else
  # Connect a worker (same container, loopback)
  docker exec -d "$ORCHESTRATOR_CID" \
    swamp worker connect ws://127.0.0.1:9090 \
      --token "$TOKEN" --label tier=smoke

  # Wait for the workflow to finish
  RUN_EXIT=0
  wait "$RUN_PID" 2>/dev/null || RUN_EXIT=$?

  if [ "$RUN_EXIT" -eq 0 ]; then
    pass "queue-on-empty then dispatch on enroll"
  else
    fail "workflow exited $RUN_EXIT after worker enrolled"
  fi
  stop_containers
fi

# ── Scenario 2: timeout with placement description ───────────────────
echo ""
echo "==> Scenario 2: timeout fires with placement description"

ORCHESTRATOR_CID=$(docker run -d --name "orch-s2-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 5s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow targeting gpu: "true" — no worker will match
TIMEOUT_START=$(date +%s)
TIMEOUT_OUTPUT=$(docker exec "$ORCHESTRATOR_CID" \
  swamp workflow run smoke-unmatched --server ws://127.0.0.1:9090 --log 2>&1 || true)
TIMEOUT_END=$(date +%s)
TIMEOUT_ELAPSED=$((TIMEOUT_END - TIMEOUT_START))

# Should take ~5s (not instant — that was the old unschedulable behavior)
if [ "$TIMEOUT_ELAPSED" -ge 3 ]; then
  pass "timeout took ${TIMEOUT_ELAPSED}s (not instant)"
else
  fail "timeout took only ${TIMEOUT_ELAPSED}s — expected ≥3s"
fi

# Error should mention the placement requirement
if echo "$TIMEOUT_OUTPUT" | grep -q "gpu=true"; then
  pass "timeout error contains placement description 'gpu=true'"
else
  fail "timeout error missing placement description"
  echo "  Output: $TIMEOUT_OUTPUT" | head -5
fi

stop_containers

# ── Scenario 3: per-step queueTimeout overrides serve default ────────
echo ""
echo "==> Scenario 3: per-step queueTimeout overrides serve default"

ORCHESTRATOR_CID=$(docker run -d --name "orch-s3-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

STEP_START=$(date +%s)
docker exec "$ORCHESTRATOR_CID" \
  swamp workflow run smoke-step-timeout --server ws://127.0.0.1:9090 --log 2>&1 || true
STEP_END=$(date +%s)
STEP_ELAPSED=$((STEP_END - STEP_START))

# Per-step queueTimeout is 3s; serve default is 30s. Should be ~3s not ~30s.
if [ "$STEP_ELAPSED" -le 10 ]; then
  pass "per-step timeout fired in ${STEP_ELAPSED}s (not serve default 30s)"
else
  fail "per-step timeout took ${STEP_ELAPSED}s — expected ≤10s"
fi

stop_containers

# ── Scenario 4: wake-on-enroll is event-driven ───────────────────────
echo ""
echo "==> Scenario 4: wake-on-enroll timing (not polling)"

ORCHESTRATOR_CID=$(docker run -d --name "orch-s4-$$" \
  -v "$REPO_DIR:/workspace" \
  "$IMAGE" serve --port 9090 --queue-timeout 30s --no-schedule)

wait_for_serve "$ORCHESTRATOR_CID" || { fail "orchestrator start"; stop_containers; exit 1; }

# Submit workflow in background
docker exec "$ORCHESTRATOR_CID" \
  swamp workflow run smoke-placed --server ws://127.0.0.1:9090 --log 2>&1 &
WAKE_PID=$!

sleep 1

# Connect worker (same container) and measure time to completion
ENROLL_START=$(date +%s)
docker exec -d "$ORCHESTRATOR_CID" \
  swamp worker connect ws://127.0.0.1:9090 \
    --token "$TOKEN2" --label tier=smoke

WAKE_EXIT=0
wait "$WAKE_PID" 2>/dev/null || WAKE_EXIT=$?
ENROLL_END=$(date +%s)
ENROLL_ELAPSED=$((ENROLL_END - ENROLL_START))

if [ "$WAKE_EXIT" -eq 0 ] && [ "$ENROLL_ELAPSED" -le 5 ]; then
  pass "wake-on-enroll: completed ${ENROLL_ELAPSED}s after worker connected (event-driven)"
elif [ "$WAKE_EXIT" -ne 0 ]; then
  fail "workflow failed with exit code $WAKE_EXIT"
else
  fail "wake-on-enroll took ${ENROLL_ELAPSED}s — expected ≤5s (poll cycle is 5s)"
fi

stop_containers

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "==> Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
