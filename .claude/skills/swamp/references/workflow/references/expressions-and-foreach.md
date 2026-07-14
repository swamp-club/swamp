# Expressions, forEach, and Data Tracking

## forEach Iteration

Steps can iterate over arrays or objects using `forEach`. Each iteration creates
a separate step instance.

### Iterate Over Array

```yaml
inputs:
  properties:
    environments:
      type: array
      items: { type: string }
      minItems: 1

jobs:
  - name: deploy-all
    steps:
      - name: deploy-${{self.env}}
        forEach:
          item: env
          in: ${{ inputs.environments }}
        task:
          type: model_method
          modelIdOrName: my-service
          methodName: deploy
          inputs:
            environment: ${{ self.env }}
```

With `--input '{"environments": ["dev", "staging", "prod"]}'`, creates steps:

- `deploy-dev`
- `deploy-staging`
- `deploy-prod`

### Iterate Over Object

```yaml
inputs:
  properties:
    tags:
      type: object
      additionalProperties: { type: string }

jobs:
  - name: apply-tags
    steps:
      - name: tag-${{self.tag.key}}
        forEach:
          item: tag
          in: ${{ inputs.tags }}
        task:
          type: model_method
          modelIdOrName: tag-manager
          methodName: apply
          inputs:
            key: ${{ self.tag.key }}
            value: ${{ self.tag.value }}
```

With `--input '{"tags": {"env": "prod", "team": "platform"}}'`, creates steps:

- `tag-env` (with `self.tag.key="env"`, `self.tag.value="prod"`)
- `tag-team` (with `self.tag.key="team"`, `self.tag.value="platform"`)

### Dynamic Targeting

During forEach expansion, `self.*` expressions resolve in **any** task field —
the step `name`, model targets (`modelIdOrName`, `modelName`, `methodName`),
workflow targets (`workflowIdOrName`), `inputs`, and shell `args` — so each
iteration can pick a different target:

```yaml
steps:
  - name: summary-${{ self.region }}
    forEach:
      item: region
      in: ${{ inputs.regions }}
    task:
      type: model_method
      modelIdOrName: aws-alarms-${{ self.region }}
      methodName: get_summary
      inputs:
        historyHours: 24
```

With `regions: ["us-east-1", "eu-west-1"]`, this creates two steps targeting
`aws-alarms-us-east-1` and `aws-alarms-eu-west-1` respectively. The resolved
names appear in `--last-evaluated` output.

The same applies to workflow tasks, so a planner can emit waves whose items each
select a workflow implementation:

```yaml
steps:
  - name: apply-${{ self.item.host }}-${{ self.item.capability }}
    forEach:
      item: item
      in: ${{ inputs.items }}
    task:
      type: workflow
      workflowIdOrName: ${{ self.item.implementation.workflowIdOrName }}
      inputs:
        host: ${{ self.item.host }}
```

`vault.*`/`env.*` and step-output/`data.*` references are left untouched during
expansion — they resolve at their own runtime/execution stage.

### forEach Variables

| Variable            | Description                    |
| ------------------- | ------------------------------ |
| `self.{item}`       | Current item (array iteration) |
| `self.{item}.key`   | Key name (object iteration)    |
| `self.{item}.value` | Value (object iteration)       |

### forEach.in with Data Helpers

`forEach.in` awaits async CEL expressions during expansion, so it accepts data
helpers directly. A common pattern is iterating over every instance produced by
a factory model:

```yaml
jobs:
  - name: process-all
    steps:
      - name: process-${{ self.instance.name }}
        forEach:
          item: instance
          in: ${{ data.findBySpec("my-factory", "instance") }}
        task:
          type: model_method
          modelIdOrName: processor
          methodName: run
          inputs:
            target: ${{ self.instance.name }}
```

Any async data helper works here — `data.findByTag()`, `data.findBySpec()`,
`data.latest()`, `data.query()`. The evaluator resolves the Promise before
walking the items.

If you want a **typed boundary** between the producer of the list and the
consumer that iterates it — for shape validation, reusable sub-processes, or
independent cadence — split into a parent + child workflow and pass the list
through `task.inputs`. See
[nested-workflows.md § When to Use Nested Workflows](nested-workflows.md#when-to-use-nested-workflows)
for the full pattern.

### forEach with Concurrency Limits

By default, all forEach iterations run in parallel. Add `concurrency` to cap
simultaneous execution — useful for rate-limited APIs or resource-constrained
hosts:

```yaml
steps:
  - name: call-${{ self.target }}
    forEach:
      item: target
      in: ${{ inputs.targets }}
    concurrency: 3
    task:
      type: model_method
      modelIdOrName: api-client
      methodName: call
      inputs:
        target: ${{ self.target }}
```

With 10 targets and `concurrency: 3`, at most 3 iterations execute at once. The
remaining iterations queue until a permit is released. Resolution order:
`step → job → workflow → unbounded` — the most-local non-zero value wins.

A global `SWAMP_MAX_CONCURRENT_STEPS` environment variable provides a host-level
ceiling: `min(local, global)` is the effective limit.

### forEach with Vary Dimensions

Use `vary` on `dataOutputOverrides` to isolate data per forEach iteration:

```yaml
steps:
  - name: deploy-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: my-service
      methodName: deploy
      inputs:
        environment: ${{ self.env }}
    dataOutputOverrides:
      - specName: result
        vary:
          - environment
```

Access varied data from a downstream forEach step using the iteration variable:

```yaml
steps:
  - name: check-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: health-checker
      methodName: check
      inputs:
        environment: ${{ self.env }}
        deployResult: ${{ data.latest('my-service', 'result', [self.env]).attributes.status }}
```

Or access a specific environment's data using workflow inputs:

```yaml
inputs:
  lastDeploy: ${{ data.latest('my-service', 'result', [inputs.environment]).attributes.status }}
```

The `vary` keys reference input key names from `task.inputs`. Each resolved
value is appended to the data name (e.g., `result-prod`, `result-dev`), giving
each iteration its own versioned storage and `latest` symlink.

## Step Task Inputs

When a step calls a model method, pass inputs to the model:

```yaml
steps:
  - name: create-resource
    task:
      type: model_method
      modelIdOrName: my-model
      methodName: create
      inputs:
        environment: ${{ inputs.environment }}
        config:
          replicas: ${{ inputs.replicas }}
```

The `inputs` field on `model_method` tasks passes values to the model's input
schema, enabling dynamic configuration at workflow runtime.

## Expressions in Workflows

Model inputs can contain CEL expressions using `${{ <expression> }}` syntax.

### Environment Variables

Access environment variables using the `env` namespace:

```yaml
attributes:
  region: ${{ env.AWS_REGION }}
  api_key: ${{ env.API_KEY }}
```

## Workflow Run Context

Inside workflow step inputs, the `run` namespace exposes metadata about the
current workflow execution. These variables are only available at **step
execution time** — not in workflow-level fields like `description`.

| Variable           | Type                    | Description                    |
| ------------------ | ----------------------- | ------------------------------ |
| `run.id`           | string (UUID)           | Unique ID of this workflow run |
| `run.workflowId`   | string (UUID)           | Workflow definition ID         |
| `run.workflowName` | string                  | Workflow name                  |
| `run.startedAt`    | string (ISO 8601)       | Timestamp when the run started |
| `run.tags`         | `Record<string,string>` | Merged workflow + runtime tags |

The flat `workflowRunId` variable is also available (equivalent to `run.id`) for
backward compatibility with `data.query()` predicates.

Use `run.id` to prevent data collisions when the same workflow runs
concurrently:

```yaml
steps:
  - name: process
    task:
      type: model_method
      modelIdOrName: my-processor
      methodName: run
      inputs:
        outputKey: "result-${{ run.id }}"
```

## Webhook Payload Context

For webhook-triggered runs, the `webhook` namespace exposes the verified request
payload. It is available **only inside `trigger.inputs`**, where expressions are
evaluated against the payload at fire time (before input validation) to map
payload fields onto named inputs.

| Variable          | Type                    | Description                                         |
| ----------------- | ----------------------- | --------------------------------------------------- |
| `webhook.body`    | unknown                 | JSON-parsed body; raw string if not JSON            |
| `webhook.headers` | `Record<string,string>` | Lowercased header names (signature header excluded) |
| `webhook.route`   | string                  | Matched webhook route (e.g. `/hooks/linear`)        |

```yaml
trigger:
  inputs:
    identifier: "${{ webhook.body.data.issue.identifier }}"
    eventType: '${{ webhook.headers["x-linear-event"] }}'
```

Guard optional payload fields with `has()` and a ternary — swamp's CEL has no
`??` operator:

```yaml
trigger:
  inputs:
    identifier: >-
      ${{ has(webhook.body.data.issue) ?
        webhook.body.data.issue.identifier : webhook.body.data.identifier }}
```

A hard reference to a missing field surfaces an error and the run does not
start. The rest of the workflow reads extracted values as normal inputs
(`${{ inputs.identifier }}`).

**Security:** `webhook.headers` values are not redacted. Avoid forwarding
sensitive headers into model attributes — they would be stored in `.swamp/data/`
and visible in `swamp data get` output.

## Data Artifact Tracking

Workflow steps track all Data artifacts produced during execution. Each step run
includes a `dataArtifacts` array with references to created data.

### Automatic Tagging

Data created during workflow execution receives automatic tags:

| Tag        | Value               | Description                       |
| ---------- | ------------------- | --------------------------------- |
| `source`   | `step-output`       | Identifies workflow-created data  |
| `workflow` | `{workflow-name}`   | Source workflow name              |
| `step`     | `{job-name}.{step}` | Full step path                    |
| `specName` | `{spec-key}`        | Output spec name for `findBySpec` |

Note: The original `type` tag (`resource` or `file`) is preserved so that
`model.*` expressions can resolve workflow-produced data across workflows.

### Querying Workflow Data

Use CEL expressions to find data from workflows:

```yaml
# Find all workflow-produced data
allStepOutputs: ${{ data.findByTag("source", "step-output") }}

# Find all data from a specific workflow
workflowOutputs: ${{ data.findByTag("workflow", "my-deploy") }}

# Find data from a specific step
stepData: ${{ data.findByTag("step", "build.compile") }}

# Find all instances from a factory model's output spec
subnets: ${{ data.findBySpec("my-scanner", "subnet") }}
```
