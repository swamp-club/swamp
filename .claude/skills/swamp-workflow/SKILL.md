---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation — define jobs and steps in YAML, wire models together with dependencies, validate DAGs, and inspect run history. Use when searching for workflows, creating new workflows, validating workflow definitions, running workflows, or viewing run history. Triggers on "swamp workflow", "run workflow", "create workflow", "automate", "automation", "orchestrate", "run history", "execute workflow", "workflow logs", "workflow failure", "debug workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI.

## CRITICAL: Workflow Creation Rules

- **Never generate workflow IDs** — no `uuidgen`, `crypto.randomUUID()`, or
  manual UUIDs. Swamp assigns IDs automatically via `swamp workflow create`.
- **Never write a workflow YAML file from scratch** — always use
  `swamp workflow create <name>` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing workflow file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help workflow` for the complete, up-to-date CLI schema.

Correct flow: `swamp workflow create <name>` → edit the YAML → validate →
run.

## Quick Reference

| Task               | Command                                                  |
| ------------------ | -------------------------------------------------------- |
| Get schema         | `swamp workflow schema get`                              |
| Search workflows   | `swamp workflow search [query]`                          |
| Get a workflow     | `swamp workflow get <id_or_name>`                        |
| Create a workflow  | `swamp workflow create <name>`                           |
| Edit a workflow    | `swamp workflow edit [id_or_name]`                       |
| Delete a workflow  | `swamp workflow delete <id_or_name>`                     |
| Validate workflow  | `swamp workflow validate [id_or_name]`                   |
| Evaluate workflow  | `swamp workflow evaluate <id_or_name>`                   |
| Run a workflow     | `swamp workflow run <id_or_name>`                        |
| Run with inputs    | `swamp workflow run <id_or_name> --input key=value`      |
| View run history   | `swamp workflow history search`                          |
| Get latest run     | `swamp workflow history get <workflow>`                   |
| View run logs      | `swamp workflow history logs <run_or_workflow>`           |
| List workflow data | `swamp data list --workflow <name>`                      |
| Search wf data     | `swamp data search --workflow <name>`                    |
| Get workflow data  | `swamp data get --workflow <name> <data_name>`           |

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
swamp workflow schema get
```

The output shows JSON Schemas for the workflow, job, step, dependency, and task
objects.

## Create a Workflow

```bash
swamp workflow create my-deploy-workflow
```

The `id` is auto-assigned and **must not be changed**. Edit the YAML file at the
returned `path` to add jobs and steps.

**Example workflow file:**

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
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

**Recommended:** Use `swamp workflow get <name>` to get the file path,
then edit directly with the Edit tool, then validate with
`swamp workflow validate <name>`.

**Alternative methods:**

- Interactive: `swamp workflow edit my-workflow` (opens in system editor)
- Stdin: `cat updated.yaml | swamp workflow edit my-workflow`

Run `swamp repo index` if search results seem stale after editing.

## Delete a Workflow

Delete a workflow and all its run history.

```bash
swamp workflow delete my-workflow
```

## Validate Workflows

Validate against schema and check for errors.

```bash
swamp workflow validate my-workflow
swamp workflow validate  # Validate all
```

## Run a Workflow

```bash
swamp workflow run my-workflow
swamp workflow run my-workflow --input environment=production
swamp workflow run my-workflow --input environment=production --input replicas=3
swamp workflow run my-workflow --input '{"environment": "production"}'  # JSON also supported
swamp workflow run my-workflow --input-file inputs.yaml
swamp workflow run my-workflow --last-evaluated  # Use pre-evaluated workflow
```

**Options:**

| Flag                | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `--input <value>`   | Input values (key=value repeatable, or JSON)                       |
| `--input-file <f>`  | Input values from YAML file                                        |
| `--last-evaluated`  | Use previously evaluated workflow (skip eval and input validation) |
| `--driver <driver>` | Override execution driver for all steps (e.g. `raw`, `docker`)     |

After execution, use `swamp data list --workflow <name>` to see produced data
and `swamp data get --workflow <name> <data_name>` to read specific items.

## Workflow History

### Search Run History

```bash
swamp workflow history search
swamp workflow history search "deploy"
```

### Get Latest Run

```bash
swamp workflow history get my-workflow
```

### View Run Logs

```bash
swamp workflow history logs my-workflow        # Latest run logs
swamp workflow history logs <run_id>           # Specific run logs
swamp workflow history logs <run_id> build.compile  # Specific step logs
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
swamp workflow evaluate my-workflow
swamp workflow evaluate my-workflow --input environment=dev
swamp workflow evaluate --all
```

**Key behaviors:**

- CEL expressions (`${{ inputs.X }}`, `${{ model.X.resource... }}`) are resolved
- forEach steps are expanded into concrete steps with resolved inputs
- Vault expressions (`${{ vault.get(...) }}`) remain raw for runtime resolution
- Output saved to `.swamp/workflows-evaluated/` for `--last-evaluated` use

## Allow Failure

Steps can be marked with `allowFailure: true` so their failure does not fail the
job or workflow. The step is still recorded as failed, but the failure is not
propagated.

```yaml
steps:
  - name: optional-check
    allowFailure: true
    task:
      type: model_method
      modelIdOrName: checker
      methodName: validate
```

- Step status remains `failed` with its error message
- The run output includes `allowedFailure: true` on the step
- Downstream `dependsOn: succeeded` steps will skip; `dependsOn: completed`
  steps will run

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

1. **Get schema**: `swamp workflow schema get`
2. **Create**: `swamp workflow create my-task`
3. **Edit**: Add jobs and steps to the YAML file
4. **Validate**: `swamp workflow validate my-task`
5. **Fix** any errors and re-validate
6. **Run**: `swamp workflow run my-task`

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Create/run models          | `swamp-model`           |
| Vault management           | `swamp-vault`           |
| Repository structure       | `swamp-repo`            |
| Manage model data          | `swamp-data`            |
| Create custom models       | `swamp-extension-model` |
| Understand swamp internals | `swamp-troubleshooting` |

## References

- **CI/CD integration**: See `swamp-repo` skill's
  [references/ci-integration.md](../swamp-repo/references/ci-integration.md) for
  installing swamp in CI and GitHub Actions examples
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
- **Execution drivers**: See
  [references/execution-drivers.md](references/execution-drivers.md) for
  per-step driver overrides and Docker execution
