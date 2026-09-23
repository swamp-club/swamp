---
audience: maintainer, operator
last-verified: 2026-08-28 @ 3d5955a9
---

# Workflows

A workflow defines what to execute. Each execution is a _Workflow Run_.

A workflow is made up of one or more _jobs_, and each job of one or more
_steps_. A step calls a method on a model or invokes another workflow.

Jobs can depend on each other. A job runs only if its dependency condition is
met, for example only when one of its upstream dependencies fails. Like steps,
jobs have conditions that trigger them.

Steps within a job, and jobs within the workflow, run in a weighted topological
sort for maximum parallelism. An optional `concurrency` field caps how many
steps in a topological level run at once. This helps with `forEach` expansions
that hit rate-limited APIs.

## Step Task Variants

A `model_method` step task has two mutually exclusive variants.

### Existing Definition (`modelIdOrName`)

Refers to an existing definition by name or ID:

```yaml
task:
  type: model_method
  modelIdOrName: my-vpc
  methodName: create
  inputs:
    cidr: "10.0.0.0/16"
```

### Direct Type Execution (`modelType` + `modelName`)

Creates the definition if it doesn't exist. The type's schemas decide which
inputs are global arguments and which are method arguments:

```yaml
task:
  type: model_method
  modelType: "@swamp/aws/ec2/vpc"
  modelName: my-vpc
  methodName: create
  inputs:
    region: us-east-1
    cidr: "10.0.0.0/16"
```

A step cannot have both `modelIdOrName` and `modelType`. Auto-created
definitions are stored in `.swamp/auto-definitions/`.

The optional `globalArgs` field passes global arguments directly and skips
schema-based input routing. When it is set, `inputs` are method arguments only:

```yaml
task:
  type: model_method
  modelType: "@myorg/deployer"
  modelName: my-deployer
  methodName: deploy
  globalArgs:
    region: us-east-1
  inputs:
    version: "1.0"
```

`globalArgs` is valid only with direct type execution. The schema rejects it
for `modelIdOrName` tasks.

`inputs` and `globalArgs` each accept a literal YAML record or a single CEL
expression that evaluates to a record at runtime:

```yaml
# Literal record (individual values may contain expressions)
inputs:
  host: ${{ self.host }}
  port: 443

# Whole-field expression (must evaluate to a record)
inputs: ${{ self.item.implementation.inputs }}
globalArgs: ${{ self.item.implementation.globalArgs }}
```

A whole-field expression is validated after evaluation. If it produces a
non-record value (null, array, number, string), the step fails with an error.

For `forEach` steps, `self.*` CEL template expressions resolve in the step
`name`, `inputs` and `globalArgs`, and in every task target field:
`modelIdOrName`, `modelName`, `methodName`, and (for workflow tasks)
`workflowIdOrName`:

```yaml
- name: scan-${{self.host}}
  forEach: { item: host, in: "${{ inputs.hosts }}" }
  task:
    type: model_method
    modelType: "@swamp/cve/dirtyfrag"
    modelName: fleet-scanner
    methodName: scanFleet
    inputs:
      host: ${{ self.host }}
```

A task target (`modelIdOrName`, `modelName`, `workflowIdOrName`) resolves when
its step runs, not at run start, if it reads `data.*` or `steps.*` or its step
has a `guard`. It then sees records that earlier steps in the same run wrote.
See "Task-target deferral" in
[../enablers/expressions.md](../enablers/expressions.md).

### Manual Approval (`manual_approval`)

Pauses the workflow at a step boundary and saves the run to disk. The operator
or another user approves or rejects it through the CLI. The original operator
then resumes the workflow to run the remaining steps.

```yaml
steps:
  - name: verify-ssh
    task:
      type: manual_approval
      prompt: "Verify Tailscale SSH access from your laptop before proceeding"
      timeout: 3600
```

**Fields:**

- `prompt` (required, string): message shown to the operator.
- `timeout` (optional, number): seconds. Checked at both approve and reject
  time against when the step was suspended (`evaluateApprovalTimeout` in
  `src/libswamp/workflows/approve.ts` and `reject.ts`). Once it expires,
  approve and reject are both refused and the run is left out of
  `swamp workflow approvals` (`src/libswamp/workflows/approvals.ts`). The run
  stays `suspended`; cancel it to clear it.

**Lifecycle: suspend → approve → resume**

1. `swamp workflow run` executes until it reaches a `manual_approval` step,
   marks it `waiting_approval`, and sets the run to `suspended`. Parallel
   siblings already in flight run on to a terminal state (succeeded, failed,
   or skipped); the executor drains all generators at the current level before
   saving. The saved record is a consistent checkpoint: each step is
   completed, parked in `waiting_approval`, or not started.

   Before starting, `workflow run` **supersedes** suspended runs of the same
   workflow whose resolved inputs deep-equal the new run's. They are cancelled
   with reason "Superseded by new run with matching inputs". Runs with
   different inputs are separate intents and are left alone, as are
   serve-owned runs (cancel those through the serve API). `--no-supersede`
   opts out. The CLI exits once the new run suspends.
2. `swamp workflow approve <workflow> <step> --run <id>` marks the step
   succeeded in the saved record; nothing executes. The local command does no
   authorization. It records `decidedBy` from `$USER`/`$USERNAME`, or
   `"unknown"` (`src/libswamp/workflows/approve.ts`). Only the `--server` path
   authorizes: the `workflow.approve` handler checks the `approve` action, not
   `run`. A `run` grant implies `approve`, so existing grants keep working, and
   an `approve`-only grant can decide gates without being able to execute the
   workflow. With `--approve-requires-explicit-grant`, serve stops counting
   `run` grants, so only a grant naming `approve` can decide a gate (see
   "Actions" in `design/enablers/access-control.md`). `--run` is optional when
   only one run is suspended.
3. `swamp workflow resume <workflow> --run <id>` re-enters the executor, skips
   completed steps, and runs the pending ones. The dashboard's Resume action
   on an approved run sends the same `workflow.resume` request, with no new
   inputs (like a CLI resume without `--input`).

**Auto-resume.** Approve and resume are separate so that resume can take
inputs. Most gated workflows need none, so serve can continue the run itself.
When a `workflow.approve` decides the run's last gate (`allGatesDecided` on
`WorkflowApproveData`), serve launches a detached resume
(`autoResumeAfterApproval` in `src/serve/resume_launcher.ts`, which shares
`startDetachedResume` with `handleWorkflowResume`). The policy is
`Workflow.shouldAutoResume(serverDefault)` (`src/domain/workflows/workflow.ts`):

- A workflow's own `autoResume: true | false` always wins.
- Otherwise `swamp serve --auto-resume` (`SWAMP_AUTO_RESUME`, serve.yaml
  `auto-resume`; default off) applies, but **only to a workflow that declares
  no inputs**. Resume-time inputs are never declared separately, so a workflow
  with inputs may rely on the placeholder-then-resume pattern below. It must
  opt in with `autoResume: true` itself.

The resume uses the workflow name and run id the approval resolved, not the
request fields. It counts against the approver's principal for the
`ActiveRunRegistry` caps, and the run keeps its original `initiatedBy`. With
auto-resume on, an `approve` grant releases a run that was authorized when it
started; that is the point of the opt-in. The approver cannot supply inputs on
this path.

Serve audits the launch as `workflow.auto_resume`, and the approve response
carries `autoResumed: true`. If the launch is refused or the resume fails,
serve logs and audits `workflow.auto_resume_failed`, and the run stays
`suspended`, awaiting resume. The same happens if two sibling gates are
approved concurrently and neither approval sees the other.

Auto-resume needs the approval to go through serve (the dashboard, or
`swamp workflow approve --server`). A local `swamp workflow approve` on the
same repository never triggers it. A suspended run with every gate decided
carries the derived `awaitingResume: true`, so the run index and
`workflow.run.search` can list it.

`swamp workflow reject <workflow> <step> --run <id>` marks the step and the run
as failed. No resume is needed.

`swamp workflow approvals` lists suspended runs awaiting approval, one row per
run, leaving out runs whose gate timed out. Each row names the first waiting
gate (`findWaitingApprovalStep` in `src/domain/workflows/workflow_run.ts`) and
shows the run id, suspended-at time, inputs digest, and ready-to-run
`--run <id>` approve/reject/resume commands. It supports `--server` /
`SWAMP_SERVE_URL` / `SWAMP_SERVER_URL` through the read-only
`workflow.approvals` wire-protocol endpoint (`read` authorization verb).

**Programmatic gate control (not wired):** `MethodContext` declares
`context.approveWorkflowGate()` / `context.rejectWorkflowGate()`, but nothing in
production builds the `WorkflowGateService` behind them.
`createWorkflowGateService` (`src/libswamp/models/workflow_gate.ts`) is called
only from tests. `src/libswamp/workflows/run.ts` leaves it unwired on purpose,
because model code bypasses authorization. On a remote worker both return
`{ ok: false }` (`src/worker/remote_method_context.ts`). Use the CLI or the
`workflow.approve` / `workflow.reject` WebSocket requests instead.

**Resume inputs (`--input`):** `swamp workflow resume` accepts `--input`,
`--input-file`, and `--stdin`, parsed as in `swamp workflow run`. They supply
values not available at the original run, such as elevated credentials,
environment overrides, or an auth key issued during the gate. Resume inputs are
deep-merged over the inputs captured at suspension (`deepMerge` in
`src/domain/workflows/execution_service.ts`): existing keys stay, nested
records merge key by key, and the resume `--input` wins on a collision. The
merged set is on the expression context before evaluation, so post-gate
`inputs.*` expressions see the new values.

Evaluation stays strict: a workflow must declare at run time every input it
references. The pattern is to declare the input at run time and supply or
override its value at resume. For example, start with `authKey` as a
placeholder and pass the real key at resume. For audit, the run record keeps
the key names of resume-time inputs, never their values, so secrets are not saved.

**Input persistence:** A run's effective inputs are captured on the run record
at run start (`run.captureInputs` in
`src/domain/workflows/execution_service.ts`, saved by the first `saveRun`) and
again at suspension. Every run's `inputs` block is on disk, so post-gate steps
can resolve `inputs.*` on resume.

**Execution report:** `swamp workflow history get --json` shows who approved or
rejected, when, and why a rejection was made. The step view has an `approval`
block with `status` (`approved` | `rejected` | `timed_out`), actor identity,
timestamp, and optional reason (`ApprovalView` in
`src/libswamp/workflows/workflow_run_view.ts`).

**Persistence:** The run record survives process restarts. Approve and resume
can happen from any machine with access to the repo (or a synced datastore).

**forEach compatibility:** A `forEach` expansion of a `manual_approval` step
creates N parallel gates, each approved by its expanded step name. `resume()`
refuses to start while any step is still `waiting_approval`
(`src/domain/workflows/execution_service.ts`), so all N must be decided first.

### Retry Failed Steps

`swamp workflow resume <workflow> --run <id>` on a **failed** run retries it
without naming a step. Every failed step and its dependents run again, in the
same run. When a run fails, the CLI prints this command after
`To retry failed steps:`. The printed command keeps an explicit `--server` or
`--repo-dir`, and the server URL loses its userinfo, query string and fragment.
If no failed step is recorded, the CLI prints
`swamp workflow history logs <id>` instead. Serve's `workflow.resume` request
behaves the same way.

**Terms:**

- **Failed step:** a stored step with status `failed` whose recorded
  `allowedFailure` is not true. The recorded value already reflects
  `allowFailure` and the assertion severity threshold in force when the run
  failed.
- **Entry template:** the workflow step a failed step came from. This is its
  `forEachTemplate`, or else its step name.
- **Reset set:** the entry templates and their transitive dependents, as stored
  step names. It is the union of `computeStepsToReset()` over each entry
  template.

**Run selection:** a bare `resume`, with no `--run` and no `--from`, still
matches only a suspended run. Failed runs are never superseded, so this keeps
approve-then-resume from becoming ambiguous. A failed run is retried only when
it is named with `--run`. One resolver serves the CLI, serve's
`workflow.resume` handler and the detached launcher (`resolveResumableRun` in
`src/domain/workflows/suspended_run_resolver.ts`). `approve` and `reject` keep
`resolveSuspendedRun`. Auto-resume passes `suspendedOnly`, so an approval never
starts a retry. This holds even if the run fails between the approval and the
launch.

**Eligibility:** a retry is refused unless all of these hold. The refusal names
the job or step and points to `swamp workflow history logs <id>`
(`selectRetryTemplates` in `src/domain/workflows/failed_step_retry.ts`).

1. No failed step is a rejected approval. Retry never re-opens a gate.
   `--from <gate>` does, and the gate then asks for a new decision.
2. Every job and step is `succeeded`, `failed` or `skipped`. This excludes
   pending, running, waiting and unknown work. It also excludes a job left
   running by a `forEach` expansion error.
3. At least one failed step exists, and every failed job contains one.
4. Each entry template is a step of the same job in the current workflow. The
   refusal suggests only a new run, because `--from` cannot stand in. On a
   renamed step, `--from` fails with `Step run not found`. On a step moved to
   another job, it completes the run without running that step. `--from` does
   still work from a remaining step after a removal. It also works from the
   template for an older `forEach` record without `forEachTemplate`.
5. Step names are unique across the workflow and across the stored run. The
   reset helper and the `steps.*` expression context key steps by name alone.

The resolver runs these checks before anything starts. Serve therefore refuses
before it registers the run or charges the principal's cap. `resume()` runs the
checks again before its first change, so a refusal saves nothing and runs no
method.

**Reset:** a retry takes the same path as `--from`. It calls
`resetForResumeFrom()` with the reset set, then `resumeFromFailed()`, then the
existing resume executor. The run keeps its id and `startedAt`. `--input`
overrides merge over the stored inputs as for any resume. An override does not
reset steps that used the old value. Reset clears each selected step's outputs,
error, approval decision and assertion result. Only jobs that contain a reset
step return to `pending`. Steps outside the set keep their state and outputs.
Guards still decide whether a reset step runs. A guard that skips a reset step
does not restore its old outputs. A template reset repeats some successful
work. It resets every stored iteration of a selected `forEach` template and
every dependent, including a successful cleanup or notify-on-failure step.

**Failure while retrying:** `resume()` takes a snapshot of the run before
changing it. The run is saved as running before steps start. If anything throws
between that save and the first step, `resume()` saves the snapshot back and
rethrows. That covers context build, `steps.*` output resolution, evaluation
and log sink registration. The run is then exactly as it was. This also covers
suspended and `--from` resumes. A retry that throws once steps are running
completes the run as failed. It can leave pending reset steps behind. Automatic
retry refuses such a run and suggests `resume --run <id> --from <step>`.

**Run tracker:** the tracker row follows the resuming process. See
[run tracker](../enablers/run-tracker.md).

**Limits:** these are part of the operator contract.

- **Retry can repeat external effects.** A method can change an external system
  and then fail. Resume does not guarantee exactly-once execution.
- **Definitions and inputs must stay compatible.** Resume uses the current
  workflow and model definitions. It does not detect definition changes or
  prove that stored results are still valid. If an input change affects earlier
  work, use `--from` or start a new run.
- **`forEach` collections must stay stable.** Item identity is not kept across
  collection changes. Use a new run for a changed collection.
- **Stored references do not guarantee data.** Ephemeral data is gone after a
  restart, and retention can remove artifacts. Resume does not rebuild missing
  outputs or pin `data.latest()` to its old value.
- **A retried nested workflow starts a new child run.** It does not resume the
  earlier child.
- **One operator per run.** There is no ownership lock. Separate CLI processes
  or serve instances can race.
- **Approvals are never reused silently.** Retry refuses a rejected approval. A
  gate in the reset set loses its decision and asks again. The `run` grant and
  `approveRequiresExplicitGrant` still govern every gate.
- **The run record keeps the original process identity.** During a resume, the
  run record still carries the pid and instance id of the process that started
  the run. `workflow cancel` may therefore not stop the resume
  (swamp-club#2420).
- **Interrupted, cancelled and running runs are out of scope.** Interrupted
  runs still use `recover`. Retry adds no crash-recovery guarantee.

### Resume from Failed Step (`--from`)

Re-enters a failed run's DAG at a named step. With `guard`, this gives safe
recovery: `--from` sets where to re-enter, and guards decide which steps run
again.

```
$ swamp workflow resume <workflow> --from <step>
$ swamp workflow resume <workflow> --from <step> --run <run-id>
```

`--run` can be left out if the workflow has exactly one failed run.

**Semantics:**

1. The `--from` step and all its transitive downstream dependents are reset to
   `pending`.
2. Steps before `--from` keep their terminal status (`succeeded`, `failed`,
   `skipped`) and the executor's existing resume-skip logic skips them.
3. Guards on reset steps are evaluated as usual, so a reset step with a truthy
   guard is still skipped.
4. Steps without a guard always run on resume. No guard means "always run this
   step."

**Step name resolution:** `--from` targets template step names as written in
the workflow YAML, not forEach-expanded iteration names. All iterations of a
forEach step are reset and re-evaluated: completed ones with truthy guards are
skipped, failed or unstarted ones run.

**Status restriction:** `--from` works only on failed runs, not succeeded or
suspended ones (use the gate-approval resume path for suspended runs). Without
`--from`, a failed run named with `--run` is retried (see
[Retry Failed Steps](#retry-failed-steps)), and a suspended run continues once
its gates are decided.

**Cross-job propagation:** If the `--from` step is in job B, only job B and
downstream jobs containing transitive dependents are reset. Upstream jobs
(job A) that succeeded keep their terminal status.

**Trigger conditions:** Trigger conditions on reset steps are still evaluated.
If the `--from` step's upstream dependency also failed, the condition sees that
`failed` status. Resume from the earlier step instead.

### Assert (`assert`)

Evaluates a CEL predicate over earlier step data, records a pass/fail result,
and fails the step when the predicate is false. It can also call model methods
with `model.method()` to check external state.

```yaml
steps:
  - name: instance-count
    task:
      type: assert
      expr: size(data.latest("cp-nodes", "instances")) == 3
      message: "Expected 3 instances, got ${{ size(data.latest('cp-nodes', 'instances')) }}"
      severity: high
```

**Fields:**

- `expr` (required, string): CEL expression evaluated with `evaluateAsync()`.
  It has the full expression context, including `data.latest()`, `inputs.*`,
  `self.*`, and `model.method()` (see
  [model.method() in guards](#modelmethod-in-guards) for syntax).
- `message` (required, string): human-readable message. Supports `${{ }}`
  interpolation. Shown on failure and included in JUnit XML output.
- `severity` (optional, `low` | `medium` | `high`, default `high`): decides
  whether a failure counts toward the `--fail-on` exit code threshold.

**Execution:** The CEL `expr` is evaluated asynchronously. Truthy marks the
step succeeded; falsy marks it failed with the resolved `message`. The
`assertResult` (passed, expr, resolved message, severity) is recorded on the
`StepRun` and saved to the workflow run record.

**Exit code control (`--fail-on`):** `swamp workflow run` accepts
`--fail-on <severity>` (default `low`). The run exits non-zero only if an
assert failure is at or above the threshold. A `low` failure under
`--fail-on high` is recorded but does not change the exit code.

**JUnit XML output (`--junit`):** `swamp workflow run --junit [--out <file>]`
emits one `<testcase>` per assert step, with a `<failure>` element when false.
Non-assert steps are left out.

**model.method() in assert:** Assert expressions can call
`model.method(modelName, methodName)` or
`model.method(modelName, methodName, inputs)`, with the same semantics as
[guard expressions](#modelmethod-in-guards). The method runs through the step
executor. It returns the parsed content of the method's `resource` data handle
if there is one, and otherwise the raw execution result as-is
(`src/domain/workflows/execution_service.ts`). This lets assertions check
external state:

```yaml
steps:
  - name: verify-instance-running
    task:
      type: assert
      expr: model.method("infra", "check-status", {"name": inputs.instanceName}).stdout == "running"
      message: "Instance ${{ inputs.instanceName }} is not running"
      severity: high
```

**forEach compatibility:** Assert steps support `forEach` expansion. Each
iteration produces its own assert result and JUnit `<testcase>`.

**Known limitation (message interpolation):** The `${{ }}` pattern in
`message` matches non-greedily, so a CEL expression with a literal `}}` (e.g.
map or struct literals) is split too early. The error is caught silently and
the expression is left as-is. Keep `message` interpolation to simple value
lookups and put complex CEL in `expr`.

**Known limits:**

- `expr` must be a raw CEL expression. Wrapping it in `${{ }}` fails
  validation (`validateAssertExprNotInterpolated` in
  `src/domain/workflows/validation_service.ts`).
- An assert failure below the `--fail-on` threshold is recorded as an
  **allowed failure** (`markAllowedFailure`). Downstream `succeeded` conditions
  see the step as failed, but the run can still succeed.
- `--fail-on` is rejected together with `--server`
  (`src/cli/commands/workflow_run.ts`). `--junit` cannot be combined with
  `--json` or with NDJSON `--stdin` batches, and `--out` requires `--junit`.

## Concurrency Limits

By default, all jobs in a topological level run at once, and so do all steps in
a topological level (maximum parallelism). The optional `concurrency` field caps
how many units run at once at each level:

```yaml
concurrency: 10  # workflow level — caps parallel jobs

jobs:
  - name: fan-out
    concurrency: 5  # job level — caps parallel steps in this job
    steps:
      - name: per-item
        forEach:
          item: target
          in: ${{ inputs.targets }}
        concurrency: 3  # step level — caps forEach iterations
        task: { ... }
```

**Semantics:**

- A positive integer is a hard cap on units running at once at that level.
- `0` or absent means unbounded (the current default).
- Resolution order is step > job > workflow > unbounded. Step-level values are
  collected across the topological level, and the minimum applies to every
  step stream in that level (`src/domain/workflows/execution_service.ts`).
  Only absent values fall through. An explicit `0` at the job level does not
  fall through to the workflow value; it resolves to unbounded (or the global
  ceiling).
- The global `SWAMP_MAX_CONCURRENT_STEPS` environment variable sets a
  host-level ceiling. When both are set, the effective limit is
  `min(local, global)`. On `workflow resume` the ceiling applies at the step
  level only; the job-level limit comes from the workflow as written.

Limiting uses a semaphore-gated `mergeWithConcurrency()` that wraps the
existing `merge()` stream combinator. When the limit is unset or above the
stream count, the unbounded `merge()` path runs with zero overhead.

Workflows are YAML files in the repository's top-level `workflows/` directory,
named `workflows/workflow-{name}.yaml` and validated with Zod. Legacy
`workflow-{uuid}.yaml` files are also supported. Run output is stored in the
datastore at `workflow-runs/{workflow-id}/workflow-run-{run-id}.yaml` (default
path: `.swamp/workflow-runs/`).

## Validation

`swamp workflow validate` checks structure (schema, unique names, dependency
references, cycles) and checks each step's inputs against the resolved
method's required arguments. To resolve a step's model type, the local path
first hot-loads pulled and local extensions (`modelRegistry.ensureLoaded()` in
`src/cli/commands/workflow_validate.ts`), as `swamp model type describe` and
`swamp model validate` do. With `--server`, the serve instance validates,
resolving types from its own loaded registry.

Results have three severity levels:

- **Pass** (green ✓): the check succeeded.
- **Warning** (yellow ⚠): the check passed but something looks suspicious.
  Warnings do not fail validation or change the exit code.
- **Fail** (red ✗): the check failed. Any failure gives a non-zero exit.

Step-input checks fail when the resolved method does not exist
(`method_not_found`) or a required argument is missing. A step whose model
type cannot be resolved also fails. It is never skipped as a pass, which
would hide real contract bugs such as non-existent method names or wrong
argument keys. Dynamic CEL references (`${{ ... }}`) in model or type names are
skipped, since they only resolve at run time. A reference to a model
instance that does not exist locally (`model_not_found`) is a warning, not a
failure: an upstream step may create it during the run, but it could
also be a typo.

### GlobalArgument Input References

A model definition's `globalArguments` or method-level argument defaults may
contain `${{ inputs.* }}` expressions. The validator checks that the calling
step's `inputs:` block supplies each referenced input. Otherwise the run would
fail with an unresolved expression, for example when a definition expects
`host: ${{ inputs.ip }}` and the step never provides it. The check uses the
step's inputs, not the workflow's top-level inputs, because in a model
definition `${{ inputs.* }}` is the model's own input namespace, filled by the
step at runtime.

Steps with dynamic inputs (a single `${{ ... }}` expression as the whole
`inputs` value) or dynamic model references are skipped, since neither can be
analysed statically. A nested-workflow step whose target workflow cannot be
found reports its input check as "skipped", not failed
(`src/domain/workflows/validation_service.ts`). The validator also checks
placement fields (`queueTimeout`, `affinity`, `writes` without a placement) and
the assert-`expr` interpolation rule above.

### Unknown Keys Are Rejected

The workflow, job, and step schemas reject unknown keys at parse time with an
actionable error (swamp-club#1240). A `rejectUnknownKeys` preprocess hook turns
off Zod's default stripping. It runs after the removed-driver-fields guard,
which keeps its own migration message.

- Placement properties (`labels`, `target`, `platform`, `queueTimeout`) are
  valid at the workflow, job, and step level (swamp-club#1685). Workflow-level
  placement is the default for all steps; job level overrides workflow, and
  step level overrides job.
- Any unknown key gets a did-you-mean suggestion (Levenshtein) and the list of
  valid keys for that entity.

The repository loader skips a schema-rejected file with a warning, so it is
invisible there. On a lookup miss, `workflow validate` and `workflow run`
re-scan the raw files and show the parse error inline. A broken file fails
validation naming the bad key, and can never make `validate` (or validate-all)
report green.

**Schema evolution consequence**: saved evaluated-workflow snapshots and
suspended approval runs are re-parsed through these schemas on resume. Removing
a schema field therefore breaks data saved before the removal and needs an
explicit migration or tolerance decision, never a silent strip. The removed
`driver`/`driverConfig` fields chose a hard, actionable failure.

## Workflow Definition

Workflows live in `workflows/workflow-{name}.yaml` (legacy
`workflow-{uuid}.yaml` files are also supported). Each has a unique id, a
globally unique name, a set of jobs, and optional workflow inputs.

### Workflow Inputs

Like model definitions, workflows can declare their own inputs (workflow
inputs) as JsonSchema. Inputs let you parameterize a workflow without editing
its definition file:

```yaml
id: abc123
name: deploy-application
inputs:
  environment:
    type: string
    enum: ["dev", "staging", "production"]
    description: "Target environment for deployment"
  version:
    type: string
    description: "Application version to deploy"
  enableRollback:
    type: boolean
    default: true
    description: "Enable automatic rollback on failure"
jobs:
# ... job definitions can reference ${{ inputs.environment }}, etc.
```

**Workflow Input Rules:**

- Specified as JsonSchema (same rules as model inputs)
- Can be required or optional
- Read through CEL expressions: `${{ inputs.someWorkflowParameter }}`
- Called "workflow inputs" to tell them apart from "model inputs"
- Provide dynamic configuration for workflow execution

See [expressions](../enablers/expressions.md) for CEL syntax and
[models](./models.md) for detailed input specification patterns.

### Workflow Triggers

A workflow can declare an optional `trigger` object holding trigger
configuration, so that `swamp serve` runs it automatically.

#### Schedule Trigger

A `schedule` trigger runs the workflow on a cron schedule:

```yaml
id: abc123
name: anime-downloader
trigger:
  schedule: "0 3,12 * * *"
jobs:
  # ... jobs run automatically at 3am and noon
```

**Schedule behavior:**

- Uses [croner](https://github.com/Hexagon/croner) grammar. Standard cron has 5
  fields (minute, hour, day-of-month, month, day-of-week). A 6-field expression
  puts **seconds first**. `@daily`-style nicknames and the `L` / `#` modifiers
  are accepted.
- Validated at parse time by building a croner `Cron`
  (`src/domain/workflows/workflow.ts`).
- On `swamp serve` startup, every workflow with a schedule is registered.
- A filesystem watcher on the `workflows/` directory reloads live. Adding,
  changing, or removing a schedule takes effect without a restart.
- Each scheduled fire calls the `executeWorkflow` callback injected into
  `ScheduledExecutionService` (`src/libswamp/workflows/scheduled_execution.ts`).
  Serve wires it to `executeWorkflowWithLocks` (`src/serve/deps.ts`), the same
  path as WebSocket `workflow.run` and webhooks, not the local CLI path.
- In an HA deployment, each fire is claimed once across instances through the
  `cronFireDedup` hook. A workflow fires single-flight per instance.
- **Overlap prevention:** if a workflow is still running from the previous
  scheduled trigger, the next trigger is skipped with a warning.
- **No catch-up:** serve does not fire schedules it missed while it was down.
  On startup it waits for the next natural cron tick.
- `--no-schedule` on `swamp serve` turns off scheduled execution.

The `ScheduledExecutionService` lives in libswamp, so any consumer (serve, a
future daemon, or programmatic use) can reuse the same scheduling code.

#### Trigger Overrides

Extension-bundled workflows are read-only, so users cannot edit their YAML to
add or change a trigger. The `triggers` section in `.swamp/serve.yaml` holds
per-workflow overrides that survive extension updates. Manage them with the CLI
or by editing `serve.yaml` directly:

```bash
# Set a trigger override (replace semantics — writes the full entry)
swamp workflow trigger set @swamp/cve/researcher/scan --schedule "0 3 * * *" --input 'channel=#security'
swamp workflow trigger set daily-report --schedule "0 8 * * 1-5"

# Show the effective trigger (built-in merged with override)
swamp workflow trigger get @swamp/cve/researcher/scan

# Remove a trigger override
swamp workflow trigger remove daily-report
```

The same overrides in `serve.yaml`:

```yaml
# .swamp/serve.yaml
triggers:
  "@swamp/cve/researcher/scan":
    schedule: "0 3 * * *"
    inputs:
      channel: "#security"
  daily-report:
    schedule: "0 8 * * 1-5"
```

Each key is a workflow name, including scoped `@collective/name` patterns. An
override `schedule` **replaces** the workflow's built-in schedule
(`resolveSchedule` in `src/libswamp/workflows/scheduled_execution.ts`). An
override `inputs` map is deep-merged over the built-in `trigger.inputs` at fire
time. A workflow with no built-in trigger block gets one from the override.
`swamp workflow trigger set` requires `--schedule`
(`src/cli/commands/workflow_trigger_set.ts`). Unknown keys in an override entry
produce a warning and are ignored (`src/serve/serve_config.ts`).

**Override behavior:**

- Applied when `ScheduledExecutionService` starts, in two phases. Every
  workflow with a schedule (built-in or override, resolved through
  `resolveSchedule`) is registered first, then the override map is walked for
  any remaining names. An inputs-only override on a workflow with no schedule
  from either source is logged and does nothing.
- The `handleScheduleChange` callback also reads the override map, so
  live-reloaded workflows respect overrides.
- Overrides for unknown workflow names are logged as warnings and skipped.
- Overrides are read at startup. Two paths apply changes to a running instance:
  1. `swamp workflow trigger set/remove --server` writes `serve.yaml`, then
     calls `updateTriggerOverrides` directly on the `ScheduledExecutionService`.
     No `--hot-reload` flag is needed
     (`src/serve/handlers/workflow_handlers.ts`).
  2. `swamp serve reload` (SIGHUP or WebSocket `serve.reload`) re-reads all
     overrides from `serve.yaml` as part of a full reload. This requires
     `--hot-reload`.
- Works with both extension and local workflows. The main use case is extension
  workflows that cannot be edited directly.

**Precedence for schedule:** `serve.yaml override > workflow YAML trigger`

**Precedence for trigger inputs:** override inputs are deep-merged over the
workflow's built-in `trigger.inputs`. Override keys win; built-in keys missing
from the override fall through. The existing
`caller inputs > trigger.inputs > schema defaults` layering is unchanged.
Override inputs take the caller inputs slot, above built-in `trigger.inputs`.

#### Trigger Inputs

Scheduled and webhook runs have no `--input` flag. A `trigger.inputs` map
supplies baseline input values at fire time:

```yaml
trigger:
  schedule: "* * * * *"
  inputs:
    projectId: "a6b254a2-0b57-4d0f-bf8b-fef767ab119e"
jobs:
  # ... runs with projectId already populated
```

A workflow can then declare `required` inputs without misusing the input
schema's `default`, which would apply to every caller, not only trigger-fired
runs. `trigger.inputs` is a plain map of runtime values to inject. The
workflow's `inputs` block is different: it is the JSON-Schema description of
allowed inputs.

**Precedence:** the values merge like `--input` on
`swamp workflow run`, layered as `caller inputs > trigger.inputs > schema
defaults`. A scheduled run has no caller, so `trigger.inputs` is the baseline.
The merged inputs go through the same coercion, default-application, and
validation pipeline as every other run, so a `required` input satisfied only
by `trigger.inputs` validates.

`executeWorkflowWithLocks` layers in trigger inputs (`workflow.baselineInputs`
in `src/serve/deps.ts`), so they apply to every serve-executed run: scheduled,
webhook, and ad-hoc `workflow.run` requests from
`swamp workflow run --server`. Only a local `swamp workflow run`, which calls
`workflowRun` directly (`src/cli/commands/workflow_run.ts`), ignores
`trigger.inputs`. There the operator supplies inputs.

#### Webhook Payload Extraction

For webhook runs, `trigger.inputs` values may be CEL expressions that read the
incoming request through the `webhook` namespace. This maps payload fields onto
named workflow inputs:

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
    eventType: '${{ webhook.headers["x-linear-event"] }}'
inputs:
  type: object
  properties:
    identifier: { type: string }
  required: [identifier]
jobs:
  # ... runs with identifier populated from the webhook body
```

The `webhook` namespace exposes:

- `webhook.body`: the request body, parsed as JSON when the payload is valid
  JSON, otherwise the raw string.
- `webhook.headers`: request headers as a map of lowercased names to values. The
  active scheme's signature header and sensitive credential headers are removed.
  Redacted headers (`REDACTED_HEADERS` in `src/serve/webhook.ts`) include:
  - authentication: `authorization`, `proxy-authorization`, `cookie`,
    `set-cookie`, `x-api-key`, `x-auth-token`
  - provider signatures: `x-hub-signature`, `x-shopify-hmac-sha256`
  - proxy credentials: `x-amzn-oidc-accesstoken`, `x-amzn-oidc-data`,
    `x-goog-iap-jwt-assertion`, `cf-access-jwt-assertion`,
    `x-forwarded-client-cert`
  - any header ending in `-token` or `-secret`
- `webhook.route`: the matched webhook route (e.g. `/hooks/linear`).

Each endpoint picks its signature scheme on the `--webhook` flag:
`<route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]`. `scheme` is
`github` (the default, `X-Hub-Signature-256`), `jira` (`X-Hub-Signature`),
`linear`, `stripe`, `slack`, `generic`, or a webhook extension type
(`@collective/name`, e.g. `@swamp/telegram`). `generic` requires a header name
and accepts an optional value prefix. With no scheme the flag behaves as
before, so the secret may still contain colons: a scheme is recognized only
when the fourth field is a known scheme keyword or an extension type. An
extension may `transform` the body before it becomes `webhook.body`, but
`webhook.headers` is always the redacted map computed by core.

These expressions are evaluated against the verified payload at fire time,
before input validation, so a payload field can satisfy a `required` input.
A whole-value expression keeps the field's native type (object, number,
boolean); one inside a larger string is interpolated.

swamp's CEL has no `??` operator. Guard optional payload fields with the
`has()` macro and a ternary instead:

```yaml
trigger:
  inputs:
    identifier: >-
      ${{ has(webhook.body.data.issue) ?
        webhook.body.data.issue.identifier : webhook.body.data.identifier }}
```

A hard reference to a missing field (without a `has()` guard) raises an error
and the run does not start. The `webhook` namespace exists only inside
`trigger.inputs`. The rest of the workflow reads the extracted values as normal
inputs (`${{ inputs.identifier }}`).

**Security:** Sensitive headers are redacted before the payload is saved or
exposed to workflow expressions. Provider event headers (e.g.
`x-github-event`, `content-type`) are kept.

**Limits** (`src/serve/webhook.ts`): request bodies are capped at 10 MB and the
in-memory run queue at 100 entries. Every verification failure returns the
same `401`, so the response cannot be used as an oracle. Webhook endpoints can
also be declared in a `webhooks:` array in `.swamp/serve.yaml`
(`src/serve/serve_config.ts`), with secrets given as `@env=`, `@file=`, or
`@vault=` references. CLI `--webhook` flags replace the config-file entries
completely.

## Jobs

Each job has a name, a description, a series of steps, and a list of the jobs
it depends on, each with the condition that triggers this job. Each `dependsOn`
entry is `{ job, condition }`. The condition is `always`, `succeeded`,
`failed`, `completed`, `skipped`, or a boolean combination with `and` / `or` /
`not` (`src/domain/workflows/trigger_condition.ts`,
`src/domain/workflows/job.ts`). For example, job C can depend on jobs A and B
and run only if either failed.

## Steps

Each step has a name, a description, and a task: a model method to run or a
nested workflow to invoke. Steps use the same dependency logic as jobs.

When a step calls a mutating model method (`create`, `update`, `delete`,
`action`), the model's pre-flight checks run first. If any check fails, the step
fails without running the method. Set `allowFailure: true` on the step to let
the workflow continue past a pre-flight failure.

## Allow Failure

A step marked `allowFailure: true` can fail without failing the job or
workflow. This helps test or diagnostic workflows where some steps may fail for
external reasons (e.g., billing plan limitations).

When such a step fails:

- The step is recorded as failed with its error message.
- The failure is not propagated to the job, so the job can still succeed.
- The step run is flagged with `allowedFailure: true` in the run output.
- Trigger conditions behave normally: `succeeded` evaluates to `false` (the
  step did fail), and `failed` and `completed` evaluate to `true`.
- Downstream steps with `dependsOn: succeeded` skip; those with
  `dependsOn: completed` fire.

```yaml
steps:
  - name: optional-check
    allowFailure: true
    task:
      type: model_method
      modelIdOrName: checker
      methodName: validate
  - name: always-runs
    dependsOn:
      - step: optional-check
        condition:
          type: completed
    task:
      type: model_method
      modelIdOrName: runner
      methodName: execute
```

## Guard (Idempotent Step Execution)

A step can declare a `guard`, a CEL expression evaluated before the step runs.
A truthy guard skips the step (already done). A falsy or absent guard lets it
run normally.

Guard is the workflow-level primitive for idempotent steps. It makes resume,
re-run, and cron scheduling safe without re-running completed steps.

### Evaluation order

1. Dependency conditions are checked (`dependsOn`)
2. Expression context is built (including `self.*` for forEach steps)
3. Guard expression is evaluated via `celEvaluator.evaluateAsync()`
4. If truthy → step is skipped with reason `"guarded"`
5. If falsy → step proceeds to execution

### Expression context

Guards see the same context as other step expressions:

- `inputs`: workflow inputs
- `data`: data namespace (e.g., `data.latest()`)
- `self`: for forEach steps, includes the iteration variable

### Guard patterns

```yaml
steps:
  # Data truthiness — truthy scalar means done, null means not done
  - name: read-plate
    guard: ${{ data.latest("plate-reader", "scan-complete").attributes.id }}
    task:
      modelName: plate-reader
      method: read-all

  # Value comparison — same batch means skip, different batch means re-run
  - name: dispense-reagent
    guard: >
      ${{ data.latest("liquid-handler", "dispense-log").attributes.batchId
          == inputs.batchId }}
    task:
      modelName: liquid-handler
      method: dispense

  # Method call — invoke a model method to check external state
  - name: create-instance
    guard: >
      ${{ model.method("infra", "check-exists",
          {"name": inputs.instanceName}).stdout }}
    task:
      modelName: infra
      method: create
```

### model.method() in guards

`model.method(modelName, methodName)` or
`model.method(modelName, methodName, inputs)` calls a model method and returns
the content of its first resource data output, parsed as JSON if possible.
Guards use it to check external state with a lightweight probe method.

The method runs through the same step executor as regular workflow steps, so it
has full access to vault secrets, expression context, and data storage. For
command/shell models the returned content is `{exitCode, stdout, stderr, ...}`,
so guards usually read one field such as `.stdout`.

### forEach compatibility

Guards can reference `self.*` (the forEach variable), so each expanded
iteration evaluates its own guard:

```yaml
- name: read-plate
  forEach:
    item: well
    in: ${{ range(1, 97) }}
  guard: ${{ data.latest("plate-reader", self.well) }}
  task:
    modelName: plate-reader
    method: read-single-well
```

On resume, completed wells are skipped and failed or unstarted wells run.

### Error handling

A CEL parse or runtime error in a guard fails the step. Guard errors are not
swallowed. They produce a `step_failed` event with the error message.

### Events and rendering

Guard-skipped steps emit a `step_skipped` event with `reason: "guarded"`
(`"dependency"` for dependency skips). The event includes `guardExpression`
(the raw CEL string) and `guardResult` (the evaluated value), so consumers can
show why the step was skipped.

Console output shows the guard expression inline:

```
   main │ skipped (guarded) · guard: data.latest("checker", "result").attributes.exitCode == 0
```

JSON output includes both fields:

```json
{"step":"do-work","job":"main","status":"skipped","reason":"guarded","guardExpression":"data.latest(\"checker\", \"result\").attributes.exitCode == 0","guardResult":true}
```

Debug-level logging (`--log-level debug`) shows the guard expression and its
result for both skipped and non-skipped steps.

## Data Output Overrides with Vary Dimensions

Steps can set `vary` on `dataOutputOverrides` to keep data separate per
environment. `vary` lists input key names whose values are appended to the data
instance name, giving names like `result-prod` or `result-dev-us-east-1`.

### Syntax

```yaml
steps:
  - name: scan-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: scanner
      methodName: execute
      inputs:
        environment: ${{ self.env }}
    dataOutputOverrides:
      - specName: result
        vary:
          - environment
```

### On-Disk Layout

With `environments: ["dev", "staging", "prod"]`, the example above produces:

```
data/scanner/{id}/
  result-dev/
    1/content.json
    latest → 1
  result-staging/
    1/content.json
    latest → 1
  result-prod/
    1/content.json
    latest → 1
```

Each environment gets its own versions and `latest` marker, so data from
different environments never interleaves.

### Accessing Varied Data

Use the 3-argument form of `data.latest()` to read varied data, usually from a
forEach step or through workflow inputs:

```yaml
# In a forEach step, use the iteration variable:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [self.env]).attributes.count }}

# Or use a workflow input:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [inputs.environment]).attributes.count }}
```

See [Expressions](../enablers/expressions.md) for the full vary dimensions
syntax.

## Pre-flight Check Control

Workflow runs support the same pre-flight check skip options as direct model
method runs. The flags apply to every model method step in the workflow:

| Flag                         | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `--skip-checks`              | Skip all pre-flight checks                 |
| `--skip-check <name>`        | Skip a specific check by name (repeatable) |
| `--skip-check-label <label>` | Skip all checks with a label (repeatable)  |

The options pass from the CLI through `WorkflowRunInput` →
`StepExecutionContext` → `MethodContext`, so behavior matches
`swamp model method run`.

## Workflow Runs

A run executes the jobs and steps in dependency order. The order should be a
weighted topological sort, so that identical inputs should give the same run
order.

The run's output is written to a workflow run log in the datastore at
`workflow-runs/{workflow-uuid}/workflow-run-{run-uuid}.yaml` (default path:
`.swamp/workflow-runs/`).

### Run Statuses

- `pending`: created but not yet started
- `running`: executing jobs/steps
- `suspended`: paused at a manual approval gate
- `succeeded`: all jobs completed successfully
- `failed`: at least one job failed or an error occurred
- `cancelled`: cancelled by a user
- `interrupted`: the owning process crashed. In-flight steps are `unknown` and
  the run is recoverable (see [Recovery](#recovery) below)

### Cancellation

Cancel a run with `swamp workflow cancel <workflow> [--run <runId>]`. When
`swamp serve` is running, the command calls the serve cancel API
(`POST /api/v1/cancel/workflow-run/<id>`), which fires the AbortController to
stop the run live. When serve is not running, the command writes the cancelled
status to the run YAML directly (offline cancel).

`swamp workflow cancel --all` cancels all active runs across all workflows.
With `--server`, `--run <id>` is required, `--all` is rejected, and `--reason`
is ignored, because the cancel endpoint takes no reason
(`src/cli/commands/workflow_cancel.ts`).

When the daemon restarts, `swamp serve` reaps orphaned runs that the previous
process left in `running` state (`reapOrphanedWorkflowRuns` in
`src/cli/commands/serve.ts`). Each is interrupted with
`run.interrupt("server_crash")` (`src/domain/workflows/workflow_run.ts`). This
marks in-flight steps as `unknown` and the run as `interrupted`, tagged
with `interrupt_reason: server_crash`. Interrupted runs are recoverable; see
[Recovery](#recovery) below.

A `RunCancelRegistry` in the serve layer tracks AbortControllers for every
execution path (scheduled, WebSocket ad-hoc, webhook). The cancel API checks
both the registry and the `ScheduledExecutionService` running map.

Model method runs cancel the same way, with
`swamp model cancel <model> [--all] [--reason <reason>]`.

### Post-Cancellation Cleanup

When a workflow is cancelled (by `--timeout`, Ctrl+C, or `swamp workflow
cancel`), steps with `always` or `completed` dependency conditions still run,
so cleanup branches (notifications, resource teardown, metric reporting) can
run. The engine evaluates the remaining steps in topological order:

- Steps whose dependency conditions are met run with a fresh 30-second cleanup
  signal. `always` is true unconditionally; `completed` is true when the
  dependency reached `succeeded` or `failed`.
- Steps whose conditions are not met (`succeeded` on a failed dependency) are
  skipped.
- In-flight steps stopped by the cancellation signal are marked `failed` with
  reason `cancelled`.

The same applies after a normal step failure without cancellation. Steps with
`always` or `completed` conditions in later topological levels run instead of
being skipped.

The `--timeout` flag kills in-flight subprocesses (SIGTERM) when the deadline
passes, then runs cleanup steps. It marks a subprocess failed without waiting
for it to finish. Values above about 24.8 days are rejected, because Deno fires
a longer timer after 1 ms (`parseTimerDuration`, `src/cli/duration_parser.ts`).

### Recovery

When a serve instance crashes during a run, the run is marked `interrupted` and
its in-flight steps `unknown`. An `unknown` step was running at crash time, so
its outcome is unclear: it may have completed externally without Swamp
recording the result.

**Step-boundary checkpoints:** the run is saved each time a step reaches a
terminal state (succeeded, failed, skipped), not only at topological level
boundaries, so a crash mid-level keeps that level's completed steps.

**Run plan identity:** at run start, the evaluated workflow is fingerprinted and
a per-run snapshot is stored in `.swamp/workflows-evaluated/runs/{runId}/`. On
recovery, the current definition's fingerprint is compared with the stored one.
If they differ, auto-recovery is refused and the operator must use
`swamp workflow resume --from <step>` instead.

**Recovery assessment (`swamp workflow recover --assess-only`):** classifies
each `unknown` step as auto-recoverable (it has a `guard` expression) or
requires-acknowledgement (no guard). A guarded step is safe to re-run, because
the guard skips it if the work was already done.

**Recovery flow:**

1. `swamp workflow recover <workflow>` assesses the interrupted run. If every
   unknown step has a guard and the fingerprints match, it resets unknown steps
   to `pending` and moves the run to `suspended`.
2. `swamp workflow resume <workflow> --run <id>` re-enters the executor. Each
   reset step's guard is evaluated: truthy (the work finished before the crash)
   skips the step, otherwise it runs again.

When unknown steps have no guards, `--acknowledge-unknown` accepts the risk of
re-running steps whose external side effects may already have happened.

**Non-goals:** recovery does not promise exactly-once execution. A crash can
happen after an external side effect succeeds but before Swamp records the step
as complete. The `unknown` status makes this visible.

## Domain Events

The WorkflowRepository and WorkflowRunRepository emit domain events:

**Workflow Events:**

- `WorkflowCreated`: a new workflow is created with `workflow create`
- `WorkflowUpdated`: a workflow definition is modified
- `WorkflowDeleted`: a workflow is deleted

**WorkflowRun Events:**

- `WorkflowRunStarted`: `workflow run` begins execution
- `WorkflowRunCompleted`: a workflow run completes successfully
- `WorkflowRunFailed`: a workflow run fails

The RepoIndexService subscribes to these events (currently a no-op
implementation). See [repo](../surfaces/repo.md) for more on domain events.

## Per-Method Telemetry

A workflow run emits one parent telemetry entry for the outer
`swamp workflow run` invocation. It also emits one child entry per workflow YAML
step that resolves to a model method. Each child links to the parent through
`parentInvocationId` and carries a `workflowContext` block:

```yaml
workflowContext:
  workflowName: deploy
  runId: <workflow-run-uuid>
  jobName: build
  stepName: validate-config
  modelType: command/shell
  executor: loopback
```

Children use the same `cli_invocation` event shape and redactions as a direct
`swamp model method run <name> <method>` invocation: `command="model"`,
`subcommand="method"`, `args=["run", "<REDACTED>", <methodName>]`. Analytics
that group by command or method therefore count direct and workflow-internal
invocations the same way. Per-executor and per-model-type queries read
`workflowContext` directly, without joining through the parent.

### Failure Semantics

- A step that fails after `method_executing` was yielded records an error child
  entry with the measured duration.
- A step that fails before `method_executing` (model lookup failure, vault
  expression resolution failure, vary-key validation failure, env-var
  validation) records a synthesized child entry with `durationMs = 0`. The
  method was never invoked, so its duration is zero. Dashboards that filter
  out zero-duration entries will hide these validation failures; this is
  expected.
- A step with `allowFailure: true` records `error` in the child entry (the
  method outcome). The parent records the overall workflow outcome: `success`
  if there were no unallowed failures. Joining
  `child.error_category × parent.success` on `parentInvocationId` shows how
  many failures were allowed, without changing the entry shape.

### V1 Limitations

- **Workflow-step granularity only.** Follow-up calls inside
  `DefaultMethodExecutionService.execute` (e.g. a method that internally
  invokes another method) are not captured as separate child entries. The
  workflow step is the unit of measurement.
- **Workflow-task steps** (steps whose task is a nested workflow) emit no child
  entry of their own. The nested workflow's model-method steps produce child
  entries linked to the same parent CLI invocation.
- **Failures before workflow validation** (e.g. workflow not found, input
  schema validation) produce no child entry, because no method was resolved.
- **Cancellation** during a method invocation (AbortSignal, timeout) records
  the in-flight method as an error child entry through the bridge's finalize
  path, with a synthetic "workflow run terminated before completion" message.

The bridge lives in `src/libswamp/workflows/telemetry_bridge.ts`. The domain
`step_failed` event has optional `modelName` and `methodName` fields, set only
at the model-method failure site. Other yield sites (nesting depth, cycle
detection, nested-workflow failure) leave them undefined, so the bridge can tell
structural failures from method failures.

### Runs Executed by `swamp serve`

Scheduled, webhook, and API-triggered runs record the same parent and child
entries as an interactive `swamp workflow run`, with two differences.

**The parent is the run, not the process.** The CLI allocates one invocation id
per process, because one CLI process is one invocation. A daemon's own
process-level entry is not written until it exits, possibly weeks later, so
children attached to it would have a dangling `parentInvocationId` for its whole
uptime. Instead, each serve-executed run forks its own service
(`TelemetryService.forkForRun`) and records a per-run parent shaped like the
`swamp workflow run` invocation it stands in for. The workflow name is redacted
the same way the CLI redacts it.

**Entries carry a `triggerSource`** of `schedule`, `webhook`, or `api`.
Interactive runs leave it unset, so their events are unchanged. The field is
not called `source` because the telemetry backend derives a field by that name
from the recorded command, and reusing it would mix two separately owned
concerns.

A run reports failure through its event stream, not by throwing: input
validation, a failed step, and cancellation all return normally. So the outcome
is read from the stream, and a run that did not reach `succeeded` records an
error parent. This matters because only successful invocations are counted
downstream.

The composition lives in `src/serve/telemetry.ts`. The sink is passed through
`executeWorkflowWithLocks` in `src/serve/deps.ts`, the single path all three
trigger types share. Callers that supply no trigger source (libswamp consumers,
tests) produce no telemetry.
