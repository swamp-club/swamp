---
audience: maintainer
enables: [workflows, models]
last-verified: 2026-08-28 @ 3d5955a9
---

# Run Tracker

Local SQLite subsystem for tracking in-flight model method and workflow run
lifecycle.

## Problem

`model method run` writes a `ModelOutput` YAML file with `status: "running"` at
start, then updates it to a terminal state on completion. Process death (OOM,
SIGKILL, power failure) leaves the YAML permanently stuck in "running" with no
mechanism for detection.

## Solution

A SQLite database at `.swamp/run_tracker.db` that owns the in-flight lifecycle.
Output YAMLs are only written once in terminal state (write-once invariant),
preserving the `findAllGlobalSince()` mtime pre-filter optimization.

**Known limit:** the write-once invariant holds for top-level
`modelMethodRun()` (`src/libswamp/models/run.ts`). Nested `context.runModel()`
invocations go through `DefaultMethodExecutionService.execute`
(`src/domain/models/method_execution_service.ts`), which still saves a
`status: "running"` output YAML before execution so the child's id is available
as `parentOutputId`; a crash mid-child leaves that YAML in `running`.

### Schema

```sql
CREATE TABLE active_runs (
  id            TEXT PRIMARY KEY,
  run_kind      TEXT NOT NULL,        -- 'model_method' | 'workflow'
  model_type    TEXT,
  method_name   TEXT,
  workflow_name TEXT,
  pid           INTEGER NOT NULL,
  hostname      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  completed_at  TEXT,
  cancel_reason TEXT,
  initiated_by  TEXT,
  instance_id   TEXT                  -- owning serve instance (HA)
);
CREATE INDEX idx_active_runs_status    ON active_runs(status);
CREATE INDEX idx_active_runs_heartbeat ON active_runs(heartbeat_at);

CREATE TABLE pending_runs (             -- queued webhook/cron fires
  id                   TEXT PRIMARY KEY,
  source               TEXT NOT NULL,
  workflow_id_or_name  TEXT NOT NULL,
  payload              TEXT,
  route                TEXT,
  traceparent          TEXT,
  tracestate           TEXT,
  created_at           TEXT NOT NULL
);
```

(`src/infrastructure/persistence/run_tracker_store.ts`.) Schema versioning via
`run_tracker_meta` table. Terminal rows older than 7 days are purged on
startup; `swamp run gc` (`src/cli/commands/run_gc.ts`, protocol `run.gc`)
collects older run records on demand with a 30-day default, `--older-than`,
`--dry-run`, and `--server`.

### Lifecycle

1. **Register** — on method/workflow start, INSERT with `pid`, `hostname`,
   `heartbeat_at = now`, `status = 'running'`
2. **Heartbeat** — every 30s, `UPDATE heartbeat_at = now WHERE id = ?`
3. **Complete** — on success/failure/cancel/suspend, UPDATE status (guarded by
   `AND status IN ('running', 'suspended')` to prevent TOCTOU races)
4. **Reap** — find stale rows (heartbeat >90s): same-machine checks
   `isProcessDead(pid)` first, cross-machine uses TTL alone. Reaping runs at
   `swamp serve` boot, `swamp model method run`, `swamp model cancel`, and
   `swamp run doctor --fix` (locally or via the `run.doctor` handler) — not on
   every CLI invocation (`reapStaleRuns` callers in `src/cli/commands/` and
   `src/serve/handlers/admin_handlers.ts`)
5. **Suspend** — workflow approval gates set status to `suspended`, which
   excludes the row from stale detection
6. **Reactivate** — on workflow resume, transitions `suspended` → `running` and
   restarts heartbeat

### Coverage

- **CLI `model method run`** and **`swamp serve` model method runs** both flow
  through `modelMethodRun()` in `run.ts`, which registers with the tracker.
- **Workflow-triggered model method runs** via `execution_service.ts`
  `DefaultStepExecutor.executeModelMethod()` register with the tracker.
- **Workflow runs** themselves register at the `WorkflowExecutionService.run()`
  level, tracking the overall workflow lifecycle.
- Workflow suspend/approve/resume/reject transitions are tracked (suspended →
  running → completed, or suspended → failed on reject).

### CLI Commands

- `swamp run history` — list recent runs (last 24h), model methods and workflows
- `swamp run history --active` — running only
- `swamp run history --all` — full tracked history
- `swamp run doctor` — diagnose stale/orphaned runs
- `swamp run doctor --fix` — auto-reap stale runs

All commands support `--server` for querying a remote `swamp serve` instance and
`--json` for structured output.

### Unhandled Rejection Guard

`swamp serve` installs a global `unhandledrejection` and `error` event handler
at startup (`src/serve/unhandled_rejection_guard.ts`). This prevents detached
rejecting promises or uncaught exceptions in extension code from terminating the
server process. The handler logs the error and calls `preventDefault()` to keep
the process alive.

The guard cannot correlate a detached rejection with a specific active run
because the rejection may fire after the run's async context has already exited.
If the rejection does orphan a run (e.g. the rejection fires during execution
and prevents the run from completing normally), the heartbeat reaper will mark
it as stale after the 90-second TTL.

### Run Metrics Tracker

A separate in-memory subsystem (`src/serve/run_metrics_tracker.ts`) that
aggregates run completion events into sliding-window throughput and latency
metrics for the health monitoring endpoints.

The RunMetricsTracker is NOT related to the SQLite-based run tracker — it is a
lightweight, in-memory, serve-only counters that records outcomes (completed,
failed, cancelled) and computes:

- Completion, failure, and cancellation counts within the window
- Throughput per minute
- Latency percentiles (P50, P95, P99)

Default window is 5 minutes. Records are pruned on snapshot or when the buffer
exceeds 10,000 entries. Event sources: scheduled execution
(schedule_completed/schedule_failed), webhook execution
(webhook_completed/webhook_failed). Runs started over the WebSocket API
(`workflow.run`, `model.method.run`) are **not** recorded
(`runMetricsTracker.record` is called only from the schedule and webhook event
handlers in `src/cli/commands/serve.ts`), so health throughput excludes them.

The metrics are surfaced on `GET /api/v1/health` and
`GET /api/v1/health/stream`.

### Local SQLite, replicated presence

The SQLite file itself is never synced — PIDs and heartbeats are inherently
local, and a PID from machine A is meaningless on machine B. In an HA
deployment (see [serve](../primitives/serve.md)) run *presence* is replicated
through the `ControlPlaneStore` instead: each instance writes
`active-runs/<instanceId>/<runId>` (`src/serve/active_run_tracker.ts`), cron
and webhook pending runs are dual-written to `pending-runs/<id>`
(`src/cli/commands/serve.ts`), and boot reconciliation
(`src/serve/boot_reconciliation.ts`) marks runs owned by a dead peer as
`failed` with reason `remote_instance_dead`.

The `/internal/runs` endpoint that exposes full run history is off by default;
it is enabled with `--enable-internal-api` / `SWAMP_ENABLE_INTERNAL_API` and
requires admin authorization (`src/cli/commands/serve.ts`).

### Related

- #636 — OOM crash leaves run stuck in "running"
- #519 — persistent, queryable workflow runs (foundation laid here)
- #1613 — Health snapshot endpoints with SSE streaming (added RunMetricsTracker
  and `/internal/runs` endpoint for full run history access)
