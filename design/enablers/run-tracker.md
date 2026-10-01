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
days are purged at startup, except a workflow row reaped `interrupted` with no
reason (`cancel_reason` null): its run record may still say `running`, and the
row is the evidence that settles it (see Dead owner below). Once the record is
settled, `markSettled` stores a reason and the row is purged as usual. `swamp run gc` removes older records on demand:
30-day default, `--older-than`, `--dry-run`, `--server`
(`src/cli/commands/run_gc.ts`, protocol `run.gc`).

### Lifecycle

1. **Register**: on start, INSERT with `pid`, `hostname`,
   `heartbeat_at = now`, `status = 'running'`.
2. **Heartbeat**: every 30s, `UPDATE heartbeat_at = now WHERE id = ?`.
3. **Complete**: on success, failure, cancel or suspend, UPDATE status, guarded
   by `AND status IN ('running', 'suspended')` against TOCTOU races. A
   cancelled owner completes its own row without a reason, so
   `swamp model cancel` then records its `--reason` with `recordCancelReason`,
   which only fills the reason on a `cancelled` row that has none.
4. **Reap**: find rows with a heartbeat older than 90s. On the same machine,
   check `isProcessDead(pid)` first; across machines, use the TTL alone. Reaped
   runs become `interrupted`, not `failed`, so they are eligible for checkpoint
   recovery. Reaping runs at `swamp serve` boot, `swamp model method run`,
   `swamp model cancel`, and `swamp run doctor --fix` (local or via the
   `run.doctor` handler), not on every CLI call (`reapStaleRuns` callers in
   `src/cli/commands/` and `src/serve/handlers/admin_handlers.ts`). The
   continuous reconciler and `run.doctor` also reconcile YAML workflow-run
   records from dead remote instances whose heartbeats are gone. Local
   `swamp run doctor` also counts a running row as stale as soon as its owner
   is a dead process on this host (`findDeadProcessRuns`), without waiting
   for the TTL, and with `--fix` reaps it through `reapDeadProcessRuns`.
7. **Dead owner**: a process killed without running its cleanup (a second
   Ctrl-C calls `Deno.exit(130)`) leaves its row `running` and its workflow
   run record `running` under its pid. Local `swamp run doctor --fix` and
   `swamp workflow recover` interrupt such a record, tagged
   `interrupt_reason: owner_process_dead`, through `settleDeadOwnerRun`
   (`src/domain/workflows/orphaned_run_reaper.ts`). Because they run while
   other swamp processes may be live, they trust only a row owned on this
   host that is `running` or `interrupted` and whose pid is dead, never a row
   the owner settled itself. The pid is checked for an `interrupted` row too:
   a serve instance reaps another instance's row on heartbeat age alone, even
   on the same host, so a stalled but live owner can be marked `interrupted`.
   A row from another host never counts; that host's own `run doctor` settles
   its runs. They re-read the
   record and write it only while it is still `running` under that pid. A
   record with no row is left alone: it carries no hostname, so on a shared
   datastore its pid says nothing about whether it is alive.
   `swamp workflow resume` on such a run, named with `--run` or the latest
   run, names `workflow recover` instead of saying to wait. Every path that
   interrupts a record after its owner died (`settleDeadOwnerRun`, the serve
   boot reaper, the `run.doctor` handler) then calls `markSettled` on the
   row, only after the record is saved. `run doctor` scans recent records
   (7 days) and finds older ones through their workflow row, by workflow
   name, so no run is stranded by age; with `--fix` it also marks settled an
   `interrupted` row whose record is no longer `running`.
5. **Suspend**: approval gates set `suspended`, which skips stale detection.
6. **Reactivate**: on resume, the row passes to the resuming process. A
   `suspended`, `failed` or `interrupted` row becomes `running` with that
   process's pid, hostname and `instance_id` (serve's instance id when serve
   drives the resume, none for a local one). `interrupted` is accepted because
   `workflow recover` sets the run record back to suspended while the row stays
   interrupted. A row that retention purged is registered again. The
   workflow-run record passes over too: the resume's first save records the
   same pid and instance id, and the row is handed over, and its heartbeat
   started, right after it, before the resume prepares. So `workflow cancel`
   stops the live resume, and serve's boot reapers find either a running row
   or, with no row, a live pid, and leave it alone. A resume that fails before
   execution restores the record, stops the heartbeat and returns the row to
   its prior status; the row keeps the failed resume's pid and hostname, which
   no reaper reads on a row that is not running. The hand-over is best-effort:
   a tracker error is logged and the resume goes on. A resume that serve
   drives carries serve's instance id while it runs, which a later serve boot
   treats as another instance's, as it does for a run serve started. When the
   run leaves `running` (suspends, finishes, is cancelled or interrupted), the
   record names its owner from before the resume again (`ownerBeforeResume`),
   so cancel routing and supersede treat it as the run of whoever started it.

### Coverage

- **CLI `model method run`** and **`swamp serve` model method runs** both go
  through `modelMethodRun()` in `run.ts`, which registers with the tracker.
- **Workflow-triggered model method runs** register via
  `DefaultStepExecutor.executeModelMethod()` in `execution_service.ts`.
- A method run serve executes, a workflow step or a direct method run, records
  serve's instance id in `instance_id`, as serve's workflow rows do, so
  `swamp model cancel` can tell its pid is the serve process. A later serve
  boot treats those rows as another instance's: it reaps them on heartbeat age
  (90s), not as soon as their pid is dead.
- **Workflow runs** register in `WorkflowExecutionService.run()` for the whole
  workflow.
- Suspend/approve/resume/reject are tracked: suspended → running → completed,
  or suspended → failed on reject. Retrying a failed run is tracked the same
  way: failed → running → completed or failed.

### CLI Commands

- `swamp run history`: runs from the last 24h, model methods and workflows
- `swamp run history --active`: running only
- `swamp run history --all`: full tracked history
- `swamp run doctor`: diagnose stale or orphaned runs
- `swamp run doctor --fix`: reap stale runs, and interrupt workflow run records
  their dead owner left `running`

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
