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
  completed_at  TEXT
);
```

Schema versioning via `run_tracker_meta` table. Terminal rows older than 7 days
are purged on startup.

### Lifecycle

1. **Register** — on method/workflow start, INSERT with `pid`, `hostname`,
   `heartbeat_at = now`, `status = 'running'`
2. **Heartbeat** — every 30s, `UPDATE heartbeat_at = now WHERE id = ?`
3. **Complete** — on success/failure/cancel/suspend, UPDATE status (guarded by
   `AND status IN ('running', 'suspended')` to prevent TOCTOU races)
4. **Reap** — on next CLI/serve invocation, find stale rows (heartbeat >90s):
   same-machine checks `isProcessDead(pid)` first, cross-machine uses TTL alone
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
- Workflow suspend/approve/resume transitions are tracked (suspended → running →
  completed).

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

### Local-only

The tracker DB is NOT synced to remote datastores. PIDs and heartbeats are
inherently local — a PID from machine A is meaningless on machine B.

### Related

- #636 — OOM crash leaves run stuck in "running"
- #519 — persistent, queryable workflow runs (foundation laid here)
