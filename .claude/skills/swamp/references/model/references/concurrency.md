# Model Method Concurrency and Locking

When a model method runs, it holds a per-instance file lock for the entire
method execution — including any awaited subprocess work inside the method.
Concurrent method runs on the **same** model instance serialize at this lock;
runs on **different** model instances proceed in parallel.

## Per-Instance Lock

- **Location:** `.swamp/data/<modelType>/<modelId>/.lock`
- **Granularity:** one lock per model instance
- **TTL:** ~30 seconds, with a heartbeat every TTL/3 (~10 seconds)
- **Stale detection:** if the lock-holder PID is no longer running, the lock is
  considered stale and force-released on the next acquisition attempt

A model method acquires its per-instance lock before execution and releases it
in a `finally` block after the method completes. If the process crashes without
releasing, the lock expires after the TTL.

## Workflow Step Locking

Workflow steps acquire per-model locks individually — the workflow does not hold
all locks upfront. Each `model_method` step acquires its target model's lock
before execution and releases it after the step completes. This means:

- Parallel steps on **different models** lock independently and run concurrently
- Parallel steps on the **same model** serialize at the lock (correct —
  concurrent writes to the same model are unsafe)
- Nested processes don't deadlock: a child `swamp` command run from a shell step
  skips the per-model locks held for the run that started it.
  `SWAMP_LOCK_ANCESTOR_PIDS`, `SWAMP_LOCK_HOLDER_PID` and
  `SWAMP_LOCK_HOLDER_TOKENS` carry this; don't set or unset them by hand. It
  still waits on locks the same swamp holds for other runs (parallel steps,
  other `swamp serve` runs)
- The same holds through `--server`: a step of a `swamp serve` run that calls
  `swamp model method run --server` (or `workflow run`) back into that serve
  hands its lock on, so a nested command under the requested run skips it
- Don't run nested structural commands (e.g. `swamp data gc`) from parallel
  steps: each waits on the other's step lock, so one of them fails within
  seconds with `lock_wait_cycle` (exit 1, not retryable from inside the step).
  Run them one at a time or in a step of their own

## Global Datastore Lock

Structural commands (`swamp repo init`, `swamp datastore sync`, etc.) acquire a
global datastore lock with a symmetric drain protocol. Per-model commands
inspect this lock before acquiring their own — if a structural command is in
flight, model commands wait for it to finish.

## Breakglass Commands

If a lock gets stuck (e.g., after a crash where stale detection hasn't kicked
in):

```bash
swamp datastore lock status                          # show who holds locks
swamp datastore lock release --force                 # release the global lock
swamp datastore lock release --force --model type/id # release a per-model lock
```

The `--force` flag is required. These commands bypass normal acquire/release and
directly delete the lock file.

## Key Takeaway

**Will concurrent model method runs serialize?** Yes, if they target the same
model instance. Different instances run in parallel. This applies equally to
standalone `swamp model method run` and workflow steps — both use the same
per-instance locking mechanism.
