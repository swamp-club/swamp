---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation. Use when searching for workflows, creating new workflows, validating workflow definitions, running workflows, or viewing run history. Triggers on "swamp workflow", "workflow", "run workflow", "create workflow", "job", "step", "automate", "automation", "pipeline", "orchestrate", "run history", "execute workflow", "workflow logs", "workflow failure", "debug workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task              | Command                                                |
| ----------------- | ------------------------------------------------------ |
| Get schema        | `swamp workflow schema get --json`                     |
| Search workflows  | `swamp workflow search [query] --json`                 |
| Get a workflow    | `swamp workflow get <id_or_name> --json`               |
| Create a workflow | `swamp workflow create <name> --json`                  |
| Edit a workflow   | `swamp workflow edit [id_or_name]`                     |
| Delete a workflow | `swamp workflow delete <id_or_name> --json`            |
| Validate workflow | `swamp workflow validate [id_or_name] --json`          |
| Evaluate workflow | `swamp workflow evaluate <id_or_name> --json`          |
| Run a workflow    | `swamp workflow run <id_or_name> --json`               |
| Run with inputs   | `swamp workflow run <id_or_name> --input '{}' --json`  |
| View run history  | `swamp workflow history search --json`                 |
| Get latest run    | `swamp workflow history get <workflow> --json`         |
| View run logs     | `swamp workflow history logs <run_or_workflow> --json` |

## Repository Structure

Swamp uses a dual-layer architecture:

- **Data directory (`/.swamp/`)** - Internal storage organized by entity type
- **Logical views (`/workflows/`)** - Human-friendly symlinked directories

```
/workflows/{workflow-name}/
  workflow.yaml → ../.swamp/workflows/{id}.yaml
  runs/
    latest → {most-recent-run}/
    {timestamp}/
      run.yaml → ../.swamp/workflow-runs/{id}/{run-id}.yaml
```

Use `swamp repo index` to rebuild if symlinks become out of sync.

## IMPORTANT: Always Get Schema First

Before creating or editing a workflow file, ALWAYS get the schema first:

```bash
swamp workflow schema get --json
```

**Output shape:**

```json
{
  "workflow": {/* JSON Schema for top-level workflow */},
  "job": {/* JSON Schema for job objects */},
  "jobDependency": {/* JSON Schema for job dependency with condition */},
  "step": {/* JSON Schema for step objects */},
  "stepDependency": {/* JSON Schema for step dependency with condition */},
  "stepTask": {/* JSON Schema for task (shell or model_method) */},
  "triggerCondition": {/* JSON Schema for dependency conditions */}
}
```

## Create a Workflow

```bash
swamp workflow create my-deploy-workflow --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "my-deploy-workflow",
  "path": "workflows/workflow-abc-123.yaml"
}
```

After creation, edit the YAML file at the returned `path` to add jobs and steps.

**Example workflow file:**

```yaml
id: abc-123
name: my-deploy-workflow
description: Deploy workflow with build and deploy jobs
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target deployment environment
    replicas:
      type: integer
      default: 1
  required: ["environment"]
jobs:
  - name: build
    description: Build the application
    steps:
      - name: compile
        description: Compile source code
        task:
          type: shell
          command: deno
          args: ["task", "build"]
  - name: deploy
    description: Deploy the application
    dependsOn:
      - job: build
        condition:
          type: succeeded
    steps:
      - name: upload
        description: Upload artifacts
        task:
          type: shell
          command: ./deploy.sh
          args: ["--env", "${{ inputs.environment }}"]
```

## Edit a Workflow

Open workflow file in your editor, or update via stdin in non-interactive mode.

```bash
# Interactive: opens in editor
swamp workflow edit my-workflow

# Non-interactive: update from stdin
cat updated-workflow.yaml | swamp workflow edit my-workflow --json

# With here-doc (agent-friendly)
swamp workflow edit my-workflow --json <<EOF
id: existing-uuid
name: my-workflow
version: 1
jobs:
  - name: updated-job
    steps:
      - name: step1
        task:
          type: shell
          command: echo
          args: ["updated"]
EOF
```

Without arguments in interactive mode, shows a search interface to select a
workflow.

**Output shape (when updating via stdin):**

```json
{
  "path": ".swamp/workflows/workflow-abc-123.yaml",
  "status": "updated",
  "name": "my-workflow",
  "id": "abc-123"
}
```

## Delete a Workflow

Delete a workflow and all its run history.

```bash
swamp workflow delete my-workflow --json
```

**Output shape:**

```json
{
  "deleted": true,
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "runsDeleted": 5
}
```

## Validate Workflows

Validate against schema and check for errors.

```bash
swamp workflow validate my-workflow --json
swamp workflow validate --json  # Validate all
```

**Output shape (single):**

```json
{
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "validations": [
    { "name": "Schema validation", "passed": true },
    { "name": "Unique job names", "passed": true },
    { "name": "Valid job dependency references", "passed": true },
    { "name": "No cyclic job dependencies", "passed": true }
  ],
  "passed": true
}
```

## Run a Workflow

```bash
swamp workflow run my-workflow --json
swamp workflow run my-workflow --input '{"environment": "production"}' --json
swamp workflow run my-workflow --input-file inputs.yaml --json
swamp workflow run my-workflow --last-evaluated --json  # Use pre-evaluated workflow
```

**Options:**

| Flag               | Description                                   |
| ------------------ | --------------------------------------------- |
| `--input <json>`   | Input values as JSON string                   |
| `--input-file <f>` | Input values from YAML file                   |
| `--last-evaluated` | Use previously evaluated workflow (skip eval) |

**Output shape:**

```json
{
  "id": "run-456",
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "status": "succeeded",
  "jobs": [
    {
      "name": "main",
      "status": "succeeded",
      "steps": [
        {
          "name": "example",
          "status": "succeeded",
          "duration": 2,
          "dataArtifacts": [
            { "dataId": "data-789", "name": "output", "version": 1 }
          ]
        }
      ],
      "duration": 2
    }
  ],
  "duration": 5,
  "path": "workflows/workflow-abc-123/workflow-run-456-timestamp.yaml"
}
```

## Workflow History

### Search Run History

Find workflow runs across all workflows.

```bash
swamp workflow history search --json
swamp workflow history search "deploy" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    {
      "runId": "run-456",
      "workflowId": "abc-123",
      "workflowName": "my-workflow",
      "status": "succeeded",
      "startedAt": "2025-01-15T10:30:00Z",
      "duration": 5
    }
  ]
}
```

### Get Latest Run

Get the most recent run for a specific workflow.

```bash
swamp workflow history get my-workflow --json
```

**Output shape:**

```json
{
  "runId": "run-456",
  "workflowId": "abc-123",
  "workflowName": "my-workflow",
  "status": "succeeded",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:05Z",
  "jobs": [/* job execution details */]
}
```

### View Run Logs

View logs and output for a workflow run or specific step.

```bash
swamp workflow history logs my-workflow --json        # Latest run logs
swamp workflow history logs run-456 --json            # Specific run logs
swamp workflow history logs run-456 build.compile --json  # Specific step logs
```

**Output shape:**

```json
{
  "runId": "run-456",
  "step": "build.compile",
  "logs": "Building application...\nCompilation complete.",
  "exitCode": 0
}
```

## Workflow Inputs

Workflows can define an `inputs` schema for parameterization. Inputs are
validated against a JSON Schema before execution.

### Input Schema

```yaml
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target environment
    replicas:
      type: integer
      default: 1
    tags:
      type: object
      additionalProperties:
        type: string
  required: ["environment"]
```

### Supported Types

| Type      | Description     | Example                                  |
| --------- | --------------- | ---------------------------------------- |
| `string`  | Text value      | `type: string`                           |
| `integer` | Whole number    | `type: integer`                          |
| `number`  | Decimal number  | `type: number`                           |
| `boolean` | True/false      | `type: boolean`                          |
| `array`   | List of items   | `type: array`, `items: { type: string }` |
| `object`  | Key-value pairs | `type: object`, `properties: {...}`      |

### Input Validation

| Constraint             | Description                       |
| ---------------------- | --------------------------------- |
| `required: [...]`      | List of required input names      |
| `enum: [...]`          | Allowed values for string/integer |
| `default: value`       | Default value if not provided     |
| `minItems/maxItems`    | Array length constraints          |
| `uniqueItems: true`    | Array must have no duplicates     |
| `additionalProperties` | Allow/restrict extra object keys  |

### Using Inputs in Expressions

Reference inputs with `${{ inputs.<name> }}`:

```yaml
steps:
  - name: deploy
    task:
      type: shell
      command: ./deploy.sh
      args: ["--env", "${{ inputs.environment }}"]
  - name: scale
    task:
      type: model_method
      modelIdOrName: my-service
      methodName: scale
      inputs:
        replicas: ${{ inputs.replicas }}
```

## Evaluate Workflows

Evaluate expressions in workflow definitions without executing. CEL expressions
are resolved and vault expressions remain raw for runtime resolution.

```bash
swamp workflow evaluate my-workflow --json
swamp workflow evaluate my-workflow --input '{"environment": "dev"}' --json
swamp workflow evaluate --all --json
```

**Options:**

| Flag               | Description                 |
| ------------------ | --------------------------- |
| `--input <json>`   | Input values as JSON string |
| `--input-file <f>` | Input values from YAML file |
| `--all`            | Evaluate all workflows      |

**Output shape (single):**

```json
{
  "name": "my-workflow",
  "outputPath": ".swamp/workflows-evaluated/abc-123.yaml"
}
```

**Output shape (--all):**

```json
{
  "total": 3,
  "evaluated": [
    { "name": "workflow-1", "outputPath": "..." },
    { "name": "workflow-2", "outputPath": "..." }
  ]
}
```

**Key behaviors:**

- CEL expressions (`${{ inputs.X }}`, `${{ model.X.resource... }}`) are resolved
- Vault expressions (`${{ vault.get(...) }}`) remain raw for runtime resolution
- Output saved to `.swamp/workflows-evaluated/` for `--last-evaluated` use

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
          type: shell
          command: echo
          args: ["${{ self.tag.key }}=${{ self.tag.value }}"]
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

## Data Artifact Tracking

Workflow steps track all Data artifacts produced during execution. Each step run
includes a `dataArtifacts` array with references to created data.

### Automatic Tagging

Data created during workflow execution receives automatic tags:

| Tag        | Value               | Description                      |
| ---------- | ------------------- | -------------------------------- |
| `type`     | `step-output`       | Identifies workflow-created data |
| `workflow` | `{workflow-name}`   | Source workflow name             |
| `step`     | `{job-name}.{step}` | Full step path                   |

### Querying Workflow Data

Use CEL expressions to find data from workflows:

```yaml
# Find all data from a specific workflow
workflowOutputs: ${{ data.findByTag("workflow", "my-deploy") }}

# Find data from a specific step
stepData: ${{ data.findByTag("step", "build.compile") }}
```

## Expressions in Workflows

Model inputs can contain CEL expressions using `${{ <expression> }}` syntax.

### Automatic Dependency Resolution

Expressions that reference `model.<name>.resource.attributes.*` create implicit
step dependencies. The workflow engine automatically ensures dependent steps run
in the correct order.

```yaml
jobs:
  - name: main
    steps:
      - name: create-subnet # Runs second (depends on vpc)
        task:
          type: model_method
          modelIdOrName: subnet-input
          methodName: create
      - name: create-vpc # Runs first
        task:
          type: model_method
          modelIdOrName: vpc-input
          methodName: create
# If subnet-input has: vpcId: ${{ model.vpc-input.resource.attributes.vpcId }}
# create-vpc runs first due to implicit dependency
```

### Environment Variables

Access environment variables using the `env` namespace:

```yaml
attributes:
  region: ${{ env.AWS_REGION }}
  api_key: ${{ env.API_KEY }}
```

## Working with Vaults

Access secrets in workflow steps using vault expressions. See **swamp-vault**
skill for complete vault management.

**Quick syntax:**

```yaml
# In step attributes
apiKey: ${{ vault.get(vault-name, secret-key) }}
dbPassword: ${{ vault.get(prod-secrets, DB_PASSWORD) }}
```

**Using the vault model** (`swamp/lets-get-sensitive`):

```yaml
- name: store-secret
  task:
    type: model_method
    modelIdOrName: store-creds # type: swamp/lets-get-sensitive
    methodName: put
```

## Workflow Example

End-to-end workflow creation:

1. **Get schema**: `swamp workflow schema get --json`
2. **Create**: `swamp workflow create my-task --json`
3. **Edit**: Add jobs and steps to the YAML file
4. **Validate**: `swamp workflow validate my-task --json`
5. **Fix** any errors and re-validate
6. **Run**: `swamp workflow run my-task --json`

## When to Use Other Skills

| Need                 | Use Skill               |
| -------------------- | ----------------------- |
| Create/run models    | `swamp-model`           |
| Vault management     | `swamp-vault`           |
| Repository structure | `swamp-repo`            |
| Manage model data    | `swamp-data`            |
| Create custom models | `swamp-extension-model` |

## References

- **Data chaining**: See
  [references/data-chaining.md](references/data-chaining.md) for aws/cli model
  workflow examples and chaining patterns
