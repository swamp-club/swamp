# Workflow Execution Semantics

## Blocking Behavior

`swamp workflow run` blocks the calling process until the run reaches a terminal
or suspended state:

- **completed** — all steps succeeded
- **failed** — a step failed (and `allowFailure` was not set)
- **cancelled** — the run was cancelled via `swamp workflow cancel` or timeout
- **suspended** — a `manual_approval` step is waiting for approval; the CLI
  exits and the run can be resumed later with `swamp workflow resume`

There is no async, detached, or fire-and-forget mode. If you need non-blocking
execution, run the workflow through `swamp serve` (which processes runs
asynchronously via its WebSocket protocol) or use a shell backgrounding
mechanism (`&`, `nohup`).

## Webhook Delivery

When `swamp serve` receives a webhook, it fires the matching workflow
synchronously within the HTTP request handler. Webhook deliveries are processed
sequentially (FIFO) per endpoint — a second delivery to the same endpoint waits
for the first run to complete or suspend before starting.

## Suspension and Resume

When a `manual_approval` step is reached:

1. The step is marked `waiting_approval`
2. The run's effective inputs are persisted to the run record
3. The run status becomes `suspended`
4. The CLI process exits

Resume is a separate invocation: `swamp workflow resume <workflow>`. It
re-enters the executor, skips completed steps, and runs the remaining pending
steps. Resume accepts `--input` to supply or override values that were not
available at the original run time (e.g., elevated credentials issued during the
gate).

## Concurrency Limits

The `concurrency` field caps parallel execution at three levels:

| Level    | Scope                                 |
| -------- | ------------------------------------- |
| workflow | caps parallel jobs                    |
| job      | caps parallel steps within the job    |
| step     | caps forEach iterations for that step |

Resolution order: step > job > workflow > `SWAMP_MAX_CONCURRENT_STEPS` env var >
unbounded. The most-local non-zero value wins.

## Timeouts and Cancellation

`swamp workflow run --timeout <seconds>` sets a cancellation deadline. If the
run has not completed when the timeout expires, it is cancelled. The `--timeout`
applies to the total wall-clock time of the run, not individual steps.

`swamp workflow cancel <workflow>` cancels an in-flight run from another
terminal or via `--server`.
