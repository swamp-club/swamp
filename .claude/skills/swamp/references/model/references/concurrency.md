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
- Nested processes are handled via `SWAMP_LOCK_HOLDER_PID` — a child `swamp`
  command skips locks held by its parent to avoid deadlock

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
