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

### forEach Variables

| Variable            | Description                    |
| ------------------- | ------------------------------ |
| `self.{item}`       | Current item (array iteration) |
| `self.{item}.key`   | Key name (object iteration)    |
| `self.{item}.value` | Value (object iteration)       |

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
