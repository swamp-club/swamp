# Workflows

The workflow is the overall definition of what to execution, represented by a
_Workflow Run_.

Each workflow is made up of one or more _jobs_.

Jobs are made up for one or more _steps_, where a step can be calling a method
on a model or invoking another workflow. Jobs can be dependent on each other,
and only execute if their dependcy condition is met (for example, only run this
job if one of its upstream dependencies fail).

Within a job, steps are executed with a weighted topological sort, so that they
have maximum paralleism through the job.

Jobs can have dependencies on other jobs. The entire workflow is executed with a
weighted topological sort, so thtat htye have maximum paralleism through the
workflow. Like steps, jobs also have conditions that trigger them.

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
