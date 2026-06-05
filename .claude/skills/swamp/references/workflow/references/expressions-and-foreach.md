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

### Dynamic Model Targeting

`self.*` expressions resolve in `modelIdOrName` and `methodName`, enabling
forEach steps to target different model instances per iteration:

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
