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
gate). If a resume fails while it is being prepared (building the expression
context and evaluating expressions, before any step runs), the run is left as it
was, so fix the input and resume again. A refusal, such as an unknown `--from`
step or an `--input` value that does not match its declared type
(`input_validation_failed`), keeps its own message and changes nothing. Other
errors, such as an `--input` value that makes an expression fail to evaluate,
exit 1 with `Workflow resume failed: ...` (`--json` code
`workflow_resume_failed`). A failure after steps start is not rolled back: check
the run with `swamp workflow history get <run-id>` before resuming again.

Resume uses the current workflow file. If it was edited during the approval
window in a way the resume would walk into (a step added or moved into a job the
resume re-runs, a pending step moved to another job, a pending job removed, or a
job renamed or added), resume refuses before anything changes and the run stays
suspended. The refusal starts with the way out:
`swamp workflow cancel <wf> --run <id>`, then start a new run. A run started by
`swamp serve` cannot be cancelled while suspended, so for one of those the
refusal says to revert the change and resume. Removing a step, and narrowing a
`forEach` through `--input`, still work. Approve and reject are not checked.
Names written with an expression are not checked, so a step added with one still
fails with `Step run not found`.

Under `swamp serve`, a workflow with `autoResume: true` resumes without that
second invocation. Serve launches the resume once an approval made through serve
decides the last gate. `--auto-resume` does the same for workflows that declare
no inputs. An automatic resume supplies no inputs. If it fails to start, the run
stays suspended and needs a manual resume, or, when the workflow changed shape,
a cancel or a revert of the change. The dashboard lists approved-but-suspended
runs with a Resume action and the equivalent CLI command.

### Retry the Failed Steps of a Failed Run

`swamp workflow resume <workflow> --run <id>` on a failed run retries every
failed step, plus everything downstream of it, in the same run. Independent
steps that succeeded keep their results and do not run again. A failed run
prints this command when it finishes. `--run` is required: a bare
`swamp workflow resume <workflow>` still matches only a suspended run.

Before retrying, check job and step states with
`swamp workflow history get <run-id> --json`. Retry refuses, and names the job
or step, when:

- a failed step is a rejected approval (use `--from <gate>` to ask again);
- any step is still pending, running, waiting, or unknown (a pending step left
  by an earlier retry: use `--from <step>`);
- a failed step was renamed, removed, or moved to another job (start a new run;
  `--from` refuses a renamed or moved step too);
- a failed step did not run because the workflow or a `forEach` collection
  changed (its `failureKind` is `workflow_changed`; start a new run);
- a step name appears in more than one job.

Retry can repeat external effects: a method may have changed something and then
failed. Successful dependents of a failed step, such as cleanup, run again, and
so does every iteration of a failed `forEach` step. Resume uses the current
workflow definition, so a changed workflow or `forEach` collection can make
stored results stale; start a new run in that case.

### Resume from a Failed Step

`swamp workflow resume <workflow> --from <step>` re-enters a failed run's DAG at
a specific step. The `--from` step and all its transitive downstream dependents
are reset to pending; steps before it retain their terminal status. Guards on
completed steps prevent re-execution of irreversible actions. Steps without
guards always execute on resume. Only works on failed runs — use the
gate-approval path for suspended runs. If multiple failed runs exist, add
`--run <run-id>` to disambiguate. Use `--from` instead of a retry to choose the
re-entry step yourself.

A `--from` or retry resume is refused, with the run left unchanged, when the
workflow changed shape since the run: a step was renamed, moved to another job,
or added to a job the resume re-runs, or a job was renamed or added. Removing a
step still works. An iteration dropped from a smaller or renamed `forEach`
collection — including one changed by an `--input` override on the resume —
fails as `Not run: ...` (`failureKind: workflow_changed`); start a new run.

## Step Evaluation Order

When a step is ready to execute (all dependency conditions met), the executor
follows this sequence:

1. **Dependency conditions** — `dependsOn` conditions are checked. If not met,
   the step is skipped with reason `"dependency"`.
2. **Expression context** — the step receives a shallow copy of the run-wide
   expression context, including `self.*` for forEach steps, `inputs.*`,
   `data.*`, and `run.*`. The `data` namespace is shared across all steps —
   `data.latest()` results are cached per-coordinate, and the cache is
   invalidated when a model method step writes data, so subsequent steps (and
   their guards) see fresh values.
3. **Guard evaluation** — if the step declares a `guard` expression, it is
   evaluated. A truthy result skips the step with reason `"guarded"` (already
   done). A falsy result proceeds to execution. A CEL error fails the step.
   Guards see writes made by earlier steps in the same run.
4. **Placement resolution** — effective placement is computed by merging
   workflow → job → step placement fields (child wins). If placement is active,
   the step dispatches to a matching worker; otherwise it runs locally.
5. **Task execution** — the step's task runs (model method, nested workflow,
   manual approval, or assert).

Guard evaluation happens after dependency checks but before task execution. This
means a guarded step still respects its dependency graph — it won't evaluate the
guard at all if its dependencies haven't been met.

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
