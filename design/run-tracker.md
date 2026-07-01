# Run Tracker

Local SQLite subsystem for tracking in-flight model method run lifecycle.

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
  run_kind      TEXT NOT NULL,
  model_type    TEXT,
  method_name   TEXT,
  workflow_name TEXT,
  pid           INTEGER NOT NULL,
  hostname      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
);
```

### Lifecycle

1. **Register** — on method start, INSERT with `pid`, `hostname`,
   `heartbeat_at = now`, `status = 'running'`
2. **Heartbeat** — every 30s, `UPDATE heartbeat_at = now WHERE id = ?`
3. **Complete** — on success/failure/cancel, UPDATE status
4. **Reap** — on next CLI/serve invocation, find stale rows (heartbeat >90s):
   same-machine checks `isProcessDead(pid)` first, cross-machine uses TTL alone

### Coverage

- **CLI `model method run`** and **`swamp serve` model method runs** both flow
  through `modelMethodRun()` in `run.ts`, which registers with the tracker.
- **Workflow-triggered model method runs** via `execution_service.ts` are NOT
  covered — deferred to #519. Serve's workflow run YAML reaping is kept as a
  fallback.

### CLI Commands

- `swamp model runs` — list active/recent runs from the tracker
- `swamp model runs --active` — running only
- `swamp doctor runs` — diagnose stale/orphaned runs
- `swamp doctor runs --fix` — auto-reap stale runs

### Related

- #636 — OOM crash leaves run stuck in "running"
- #519 — persistent, queryable workflow runs (builds on this foundation)
