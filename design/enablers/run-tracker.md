---
audience: maintainer
enables: [workflows, models]
last-verified: 2026-08-28 @ 3d5955a9
---

# Run Tracker

A local SQLite subsystem that tracks in-flight model method and workflow runs.

## Problem

`model method run` writes a `ModelOutput` YAML file with `status: "running"` at
start and updates it when the run ends. If the process dies (OOM, SIGKILL,
power failure), the YAML stays "running" and nothing notices.

## Solution

A SQLite database at `.swamp/run_tracker.db` owns the in-flight lifecycle.
Output YAMLs are written once, in their terminal state. This write-once rule
keeps the `findAllGlobalSince()` mtime pre-filter working.

**Known limit:** write-once holds for top-level `modelMethodRun()`
(`src/libswamp/models/run.ts`). Nested `context.runModel()` calls go through
`DefaultMethodExecutionService.execute`, which still saves a
`status: "running"` output YAML first so the child's id can serve as
`parentOutputId` (`src/domain/models/method_execution_service.ts`). A crash
mid-child leaves that YAML in `running`.

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

(`src/infrastructure/persistence/run_tracker_store.ts`.) The
`run_tracker_meta` table holds the schema version. Terminal rows older than 7
days are purged at startup. `swamp run gc` removes older records on demand:
30-day default, `--older-than`, `--dry-run`, `--server`
(`src/cli/commands/run_gc.ts`, protocol `run.gc`).

### Lifecycle

1. **Register**: on start, INSERT with `pid`, `hostname`,
   `heartbeat_at = now`, `status = 'running'`.
2. **Heartbeat**: every 30s, `UPDATE heartbeat_at = now WHERE id = ?`.
3. **Complete**: on success, failure, cancel or suspend, UPDATE status, guarded
   by `AND status IN ('running', 'suspended')` against TOCTOU races.
4. **Reap**: find rows with a heartbeat older than 90s. On the same machine,
   check `isProcessDead(pid)` first; across machines, use the TTL alone. Reaped
   runs become `interrupted`, not `failed`, so they are eligible for checkpoint
   recovery. Reaping runs at `swamp serve` boot, `swamp model method run`,
   `swamp model cancel`, and `swamp run doctor --fix` (local or via the
   `run.doctor` handler), not on every CLI call (`reapStaleRuns` callers in
   `src/cli/commands/` and `src/serve/handlers/admin_handlers.ts`). The
   continuous reconciler and `run.doctor` also reconcile YAML workflow-run
   records from dead remote instances whose heartbeats are gone.
5. **Suspend**: approval gates set `suspended`, which skips stale detection.
6. **Reactivate**: on resume, `suspended` → `running` and the heartbeat
   restarts.

### Coverage

- **CLI `model method run`** and **`swamp serve` model method runs** both go
  through `modelMethodRun()` in `run.ts`, which registers with the tracker.
- **Workflow-triggered model method runs** register via
  `DefaultStepExecutor.executeModelMethod()` in `execution_service.ts`.
- **Workflow runs** register in `WorkflowExecutionService.run()` for the whole
  workflow.
- Suspend/approve/resume/reject are tracked: suspended → running → completed,
  or suspended → failed on reject.

### CLI Commands

- `swamp run history`: runs from the last 24h, model methods and workflows
- `swamp run history --active`: running only
- `swamp run history --all`: full tracked history
- `swamp run doctor`: diagnose stale or orphaned runs
- `swamp run doctor --fix`: reap stale runs

All support `--server` for a remote `swamp serve` instance and `--json`.

### Unhandled Rejection Guard

`swamp serve` installs global `unhandledrejection` and `error` event handlers at
startup so detached rejections or uncaught exceptions in extension code cannot
kill the server. The handler logs the error and calls `preventDefault()`
(`src/serve/unhandled_rejection_guard.ts`).

The guard cannot link a rejection to a run, since it may fire after the run's
async context has exited. If a rejection does orphan a run, the heartbeat reaper
marks it stale after the 90-second TTL.

### Run Metrics Tracker

A separate, in-memory, serve-only set of counters
(`src/serve/run_metrics_tracker.ts`) that feeds the health endpoints. It is not
related to the SQLite run tracker. It records outcomes (completed, failed,
cancelled) and computes over a sliding window:

- Completion, failure, and cancellation counts within the window
- Throughput per minute
- Latency percentiles (P50, P95, P99)

The window defaults to 5 minutes. Records are pruned on snapshot or past 10,000
entries. Sources are scheduled runs (schedule_completed/schedule_failed) and
webhook runs (webhook_completed/webhook_failed). Runs started over the WebSocket
API (`workflow.run`, `model.method.run`) are **not** recorded, so health
throughput excludes them (`runMetricsTracker.record` is called only from the
schedule and webhook handlers in `src/cli/commands/serve.ts`). A webhook run
suspended on an approval gate records nothing until it resumes.

The metrics appear on `GET /api/v1/health` and `GET /api/v1/health/stream`.

### Local SQLite, replicated presence

The SQLite file is never synced, because PIDs and heartbeats mean nothing on
another machine. In an HA deployment (see [serve](../primitives/serve.md)), run
presence is replicated through the `ControlPlaneStore`:

- Each instance writes `active-runs/<instanceId>/<runId>`
  (`src/serve/active_run_tracker.ts`).
- Cron and webhook pending runs are also written to `pending-runs/<id>`
  (`src/cli/commands/serve.ts`).
- Boot reconciliation marks runs owned by a dead peer `failed` with reason
  `remote_instance_dead` (`src/serve/boot_reconciliation.ts`).

The `/internal/runs` endpoint exposes full run history. It is off by default,
enabled with `--enable-internal-api` / `SWAMP_ENABLE_INTERNAL_API`, and needs
admin authorization (`src/cli/commands/serve.ts`).

### Related

- #636: OOM crash leaves run stuck in "running"
- #519: persistent, queryable workflow runs (foundation laid here)
- #1613: health snapshot endpoints with SSE streaming (added RunMetricsTracker
  and the `/internal/runs` endpoint for full run history)
