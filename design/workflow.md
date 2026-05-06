# Workflows

The workflow is the overall definition of what to execution, represented by a
_Workflow Run_.

Each workflow is made up of one or more _jobs_.

Jobs are made up for one or more _steps_, where a step can be calling a method
on a model or invoking another workflow. Jobs can be dependent on each other,
and only execute if their dependcy condition is met (for example, only run this
job if one of its upstream dependencies fail).

Within a job, steps are executed with a weighted topological sort, so that they
have maximum parallelism through the job. Steps support an optional
`concurrency` field that caps how many steps in a topological level run
simultaneously — particularly useful for `forEach` expansions that hit
rate-limited APIs.

Jobs can have dependencies on other jobs. The entire workflow is executed with a
weighted topological sort, so that they have maximum parallelism through the
workflow. Like steps, jobs also have conditions that trigger them.

## Concurrency Limits

By default, all jobs in a topological level and all steps in a topological level
run concurrently (maximum parallelism). The optional `concurrency` field caps
the number of simultaneously executing units at each level:

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

- A positive integer is a hard cap on simultaneously executing units at that
  level.
- `0` or absent means unbounded (current default behavior).
- Resolution order: step > job > workflow > unbounded. The most-local non-zero
  value wins.
- A global `SWAMP_MAX_CONCURRENT_STEPS` environment variable provides a
  host-level ceiling. The effective limit is `min(local, global)` when both are
  set.

Concurrency limiting is implemented via a semaphore-gated
`mergeWithConcurrency()` that wraps the existing `merge()` stream combinator.
When the limit is unset or exceeds the stream count, the unbounded `merge()` path
is used with zero overhead.

Workflows are specified in YAML files, that are validated with Zod, in the
top-level `workflows/` directory of the repository, as
`workflows/workflow-{uuid}.yaml`. Workflow run output is stored in the datastore
at `workflow-runs/{workflow-uuid}/{run-uuid}.yaml` (default path:
`.swamp/workflow-runs/`).

## Workflow Definition

Workflows are specified in `workflows/workflow-{uuid}.yaml`. They have a unique
id, a globally unique name, a set of jobs, and optionally workflow inputs.

### Workflow Inputs

Like model definitions, workflows can specify custom inputs (workflow inputs) as
JsonSchema. These inputs allow parameterizing workflows without modifying the
workflow definition file:

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
- Accessed through CEL expressions: `${{ inputs.someWorkflowParameter }}`
- Distinguish as "workflow inputs" (different from "model inputs")
- Provide dynamic configuration for workflow execution

See [./expressions.md] for CEL expression syntax and [./models.md] for detailed
input specification patterns.

### Workflow Triggers

Workflows can declare a `trigger` section to enable automatic execution via
`swamp serve`. The `trigger` section is an optional object that contains trigger
configuration.

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

- Uses standard 5-field cron syntax (minute, hour, day-of-month, month,
  day-of-week), plus optional seconds field
- Validated at parse time using [croner](https://github.com/Hexagon/croner)
- On `swamp serve` startup, all workflows with schedules are registered
- A filesystem watcher monitors the `workflows/` directory for live reload —
  adding, changing, or removing a schedule takes effect without restart
- Each scheduled trigger calls `workflowRun` via libswamp (same code path as
  CLI and WebSocket)
- **Overlap prevention:** If a workflow is still running from a previous
  scheduled trigger, the next trigger is skipped with a warning
- **No catch-up:** If serve was down during a scheduled time, it does not fire
  missed schedules on startup — it waits for the next natural cron tick
- Use `--no-schedule` on `swamp serve` to disable scheduled execution

The `ScheduledExecutionService` lives in libswamp, so any consumer (serve, a
future daemon, or programmatic use) can use the same scheduling infrastructure.

## Jobs

Each job has a name, a description, a series of steps, and an array of objects
that specify other jobs it depends on that also includes the trigger for this
job to execute. For example, you can specify that job C depends on job A and B,
and it triggers only if job A or job B fail. You should be able to express
complex boolean trigger logic.

## Steps

Each step has a name, a descirption, and a task (which is either a method on a
model to run or a nested workflow to invoke). Each step has dependency logic that
is identical to jobs, only for steps rather than jobs.

When a step invokes a mutating model method (`create`, `update`, `delete`,
`action`), the model's pre-flight checks run automatically before execution. If
any check fails, the step fails immediately without executing the method. Use
`allowFailure: true` on the step to allow the workflow to continue past a
pre-flight failure.

## Allow Failure

Steps can be marked with `allowFailure: true` to indicate that their failure
should not cause the job or workflow to fail. This is useful for test or
diagnostic workflows where some steps may fail due to external constraints (e.g.,
billing plan limitations).

When a step with `allowFailure: true` fails:

- The step is recorded as **failed** with its error message
- The failure is **not propagated** to the job — the job can still succeed
- The step run is flagged with `allowedFailure: true` in the run output
- Trigger conditions behave normally: `succeeded` evaluates to `false` (step did
  fail), `failed` evaluates to `true`, `completed` evaluates to `true`
- Downstream steps with `dependsOn: succeeded` will skip; `dependsOn: completed`
  will fire

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

## Data Output Overrides with Vary Dimensions

Steps can declare `vary` on `dataOutputOverrides` to produce
environment-isolated data storage. The `vary` field lists input key names whose
values are appended to the data instance name, creating composite names like
`result-prod` or `result-dev-us-east-1`.

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

With `environments: ["dev", "staging", "prod"]`, the above produces:

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

Each environment gets its own versioning and `latest` symlink, preventing
cross-environment data interleaving.

### Accessing Varied Data

Use the 3-argument form of `data.latest()` to dynamically access varied data,
typically from a forEach step or via workflow inputs:

```yaml
# In a forEach step, use the iteration variable:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [self.env]).attributes.count }}

# Or use a workflow input:
inputs:
  scanResult: ${{ data.latest('scanner', 'result', [inputs.environment]).attributes.count }}
```

See [Expressions](./expressions.md) for the full vary dimensions syntax.

## Pre-flight Check Control

Workflow runs support the same pre-flight check skip options as direct model
method invocations. These flags apply to all model method steps in the workflow:

| Flag                         | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| `--skip-checks`              | Skip all pre-flight checks                 |
| `--skip-check <name>`        | Skip a specific check by name (repeatable) |
| `--skip-check-label <label>` | Skip all checks with a label (repeatable)  |

Check skip options are threaded from the CLI through `WorkflowRunInput` →
`StepExecutionContext` → `MethodContext`, ensuring consistent behavior with
`swamp model method run`.

## Workflow Runs

When a workflow is run, it executes the jobs and steps in the correct order. The
order should be topologically sorted for dependencies, and weighted so it does
not vary between identical inputs. (If the inputs are identical, the run order
should be deterministic.)

The output of the run will be written to a workflow run log, kept in the
datastore at `workflow-runs/{workflow-uuid}/{run-uuid}.yaml` (default path:
`.swamp/workflow-runs/`).

## Domain Events

The WorkflowRepository and WorkflowRunRepository emit domain events:

**Workflow Events:**

- `WorkflowCreated` - Emitted when a new workflow is created via
  `workflow create`
- `WorkflowUpdated` - Emitted when a workflow definition is modified
- `WorkflowDeleted` - Emitted when a workflow is deleted

**WorkflowRun Events:**

- `WorkflowRunStarted` - Emitted when `workflow run` begins execution
- `WorkflowRunCompleted` - Emitted when a workflow run completes successfully
- `WorkflowRunFailed` - Emitted when a workflow run fails

The RepoIndexService subscribes to these events (currently a noop
implementation). See [./repo.md] for details on domain events.
