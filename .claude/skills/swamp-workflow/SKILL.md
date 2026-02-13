---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation. Use when searching for workflows, creating new workflows, validating workflow definitions, running workflows, or viewing run history. Triggers on "swamp workflow", "workflow", "run workflow", "create workflow", "job", "step", "automate", "automation", "pipeline", "orchestrate", "run history", "execute workflow", "workflow logs", "workflow failure", "debug workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task               | Command                                                |
| ------------------ | ------------------------------------------------------ |
| Get schema         | `swamp workflow schema get --json`                     |
| Search workflows   | `swamp workflow search [query] --json`                 |
| Get a workflow     | `swamp workflow get <id_or_name> --json`               |
| Create a workflow  | `swamp workflow create <name> --json`                  |
| Edit a workflow    | `swamp workflow edit [id_or_name]`                     |
| Delete a workflow  | `swamp workflow delete <id_or_name> --json`            |
| Validate workflow  | `swamp workflow validate [id_or_name] --json`          |
| Evaluate workflow  | `swamp workflow evaluate <id_or_name> --json`          |
| Run a workflow     | `swamp workflow run <id_or_name> --json`               |
| Run with inputs    | `swamp workflow run <id_or_name> --input '{}' --json`  |
| View run history   | `swamp workflow history search --json`                 |
| Get latest run     | `swamp workflow history get <workflow> --json`         |
| View run logs      | `swamp workflow history logs <run_or_workflow> --json` |
| List workflow data | `swamp data list --workflow <name> --json`             |
| Search wf data     | `swamp data search --workflow <name> --json`           |
| Get workflow data  | `swamp data get --workflow <name> <data_name> --json`  |

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
  "stepTask": {/* JSON Schema for task (model_method or workflow) */},
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
          type: model_method
          modelIdOrName: build-runner
          methodName: build
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
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
          inputs:
            environment: ${{ inputs.environment }}
```

## Edit a Workflow

**Recommended:** Use `swamp workflow get <name> --json` to get the file path,
then edit directly with the Edit tool, then validate with
`swamp workflow validate <name> --json`. Never modify the `id` field.

**Alternative methods:**

- Interactive: `swamp workflow edit my-workflow` (opens in system editor)
- Stdin: `cat updated.yaml | swamp workflow edit my-workflow --json`

Run `swamp repo index` if search results seem stale after editing.

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

| Flag               | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| `--input <json>`   | Input values as JSON string                                        |
| `--input-file <f>` | Input values from YAML file                                        |
| `--last-evaluated` | Use previously evaluated workflow (skip eval and input validation) |

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

### Using Inputs in Expressions

Reference inputs with `${{ inputs.<name> }}`:

```yaml
steps:
  - name: deploy
    task:
      type: model_method
      modelIdOrName: deploy-service
      methodName: deploy
      inputs:
        environment: ${{ inputs.environment }}
```

## Evaluate Workflows

Evaluate expressions without executing. CEL expressions are resolved; vault
expressions remain raw for runtime resolution.

```bash
swamp workflow evaluate my-workflow --json
swamp workflow evaluate my-workflow --input '{"environment": "dev"}' --json
swamp workflow evaluate --all --json
```

**Key behaviors:**

- CEL expressions (`${{ inputs.X }}`, `${{ model.X.resource... }}`) are resolved
- forEach steps are expanded into concrete steps with resolved inputs
- Vault expressions (`${{ vault.get(...) }}`) remain raw for runtime resolution
- Output saved to `.swamp/workflows-evaluated/` for `--last-evaluated` use

## Step Task Types

Steps support two task types:

**`model_method`** - Call a method on a model:

```yaml
task:
  type: model_method
  modelIdOrName: my-model
  methodName: run
  inputs: # Optional: pass values to the model
    key: ${{ inputs.value }}
```

**`workflow`** - Invoke another workflow (waits for completion):

```yaml
task:
  type: workflow
  workflowIdOrName: child-workflow
  inputs: # Optional: pass inputs to the child workflow
    key: value
```

Nested workflows have a max depth of 10 and cycle detection is enforced.

## Working with Vaults

Access secrets using vault expressions. See **swamp-vault** skill for details.

```yaml
apiKey: ${{ vault.get(vault-name, secret-key) }}
dbPassword: ${{ vault.get(prod-secrets, DB_PASSWORD) }}
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

- **Nested workflows**: See
  [references/nested-workflows.md](references/nested-workflows.md) for full
  examples of workflows calling other workflows, forEach with workflows, and
  nesting limitations
- **Expressions, forEach, and data tracking**: See
  [references/expressions-and-foreach.md](references/expressions-and-foreach.md)
  for forEach iteration patterns, CEL expressions, environment variables, and
  data artifact tagging
- **Data chaining and lifecycle workflows**: See
  [references/data-chaining.md](references/data-chaining.md) for `model.*` vs
  `data.latest()` expression guidance, delete/update workflow ordering, and
  command/shell chaining examples
