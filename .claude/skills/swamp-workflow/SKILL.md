---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation — define jobs and steps in YAML, wire models together with dependencies, validate DAGs, and inspect run history. Use when searching for workflows, creating new workflows, validating workflow definitions, running workflows, or viewing run history. Triggers on "swamp workflow", "run workflow", "create workflow", "automate", "automation", "orchestrate", "run history", "execute workflow", "workflow logs", "workflow failure", "debug workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## CRITICAL: Workflow Creation Rules

- **Never generate workflow IDs** — no `uuidgen`, `crypto.randomUUID()`, or
  manual UUIDs. Swamp assigns IDs automatically via `swamp workflow create`.
- **Never write a workflow YAML file from scratch** — always use
  `swamp workflow create <name> --json` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing workflow file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help workflow` for the complete, up-to-date CLI schema.

Correct flow: `swamp workflow create <name> --json` → edit the YAML → validate →
run.

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
| Run a workflow     | `swamp workflow run <id_or_name>`                      |
| Run with inputs    | `swamp workflow run <id_or_name> --input key=value`    |
| View run history   | `swamp workflow history search --json`                 |
| Get latest run     | `swamp workflow history get <workflow> --json`         |
| View run logs      | `swamp workflow history logs <run_or_workflow> --json` |
| List workflow data | `swamp data list --workflow <name> --json`             |
| Query wf data      | `swamp data query 'tags.workflow == "<name>"'`         |
| Get workflow data  | `swamp data get --workflow <name> <data_name> --json`  |

## Repository Structure

Workflow files are stored directly in the `workflows/` directory:

```
workflows/
  workflow-{uuid}.yaml
```

Internal data (evaluated workflows, run records) lives in `.swamp/`:

```
.swamp/workflows-evaluated/{uuid}.yaml
.swamp/workflow-runs/{workflow-id}/{run-id}.yaml
```

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
  "id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "name": "my-deploy-workflow",
  "path": "workflows/workflow-3fa85f64-5717-4562-b3fc-2c963f66afa6.yaml"
}
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

## Scheduled Workflows

Workflows can declare a `trigger` section with a `schedule` cron expression for
automatic execution via `swamp serve`:

```yaml
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
name: anime-downloader
trigger:
  schedule: "0 3,12 * * *"
jobs:
  - name: download
    steps:
      - name: fetch
        task:
          type: model_method
          modelIdOrName: downloader
          methodName: execute
```

When `swamp serve` starts, it scans all workflows and registers cron entries for
any with `trigger.schedule`. A filesystem watcher monitors for changes — adding,
modifying, or removing a schedule takes effect without restart.

**Key behaviors:**

- Overlap prevention: if still running from previous trigger, next trigger skips
- No catch-up: missed schedules while serve was down are not fired on startup
- Use `--no-schedule` on `swamp serve` to disable scheduled execution
- Health endpoint (`/health`) reports scheduled workflows and next fire times

## Edit a Workflow

**Recommended:** Use `swamp workflow get <name> --json` to get the file path,
then edit directly with the Edit tool, then validate with
`swamp workflow validate <name> --json`.

**Alternative methods:**

- Interactive: `swamp workflow edit my-workflow` (opens in system editor)
- Stdin: `cat updated.yaml | swamp workflow edit my-workflow --json`

## Delete a Workflow

Delete a workflow and all its run history.

```bash
swamp workflow delete my-workflow --json
```

**Output shape:**

```json
{
  "deleted": true,
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "runsDeleted": 5
}
```

## Validate Workflows

Validate against schema, check for structural errors, and verify that step
inputs match required method/workflow arguments.

**Checks performed:**

1. Schema validation (Zod)
2. Unique job names
3. Unique step names within each job
4. Valid job dependency references
5. Valid step dependency references
6. No cyclic job dependencies
7. No cyclic step dependencies within jobs
8. Step inputs match required arguments — for `model_method` tasks, checks that
   all required method arguments are provided in the step's `inputs:` block. For
   `workflow` tasks, checks that all required workflow inputs are provided.
   Dynamic CEL references (`${{ ... }}`) in model/workflow names are skipped.

```bash
swamp workflow validate my-workflow --json
swamp workflow validate --json  # Validate all
```

**Output shape (single):**

```json
{
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "workflowName": "my-workflow",
  "validations": [
    { "name": "Schema validation", "passed": true },
    { "name": "Unique job names", "passed": true },
    { "name": "Valid job dependency references", "passed": true },
    { "name": "No cyclic job dependencies", "passed": true },
    {
      "name": "Step inputs for 'deploy' in job 'release' (my-app.deploy)",
      "passed": true
    }
  ],
  "passed": true
}
```

## Run a Workflow

```bash
swamp workflow run my-workflow
swamp workflow run my-workflow --input environment=production
swamp workflow run my-workflow --input environment=production --input replicas=3
swamp workflow run my-workflow --input 'tags:json=["prod","west"]'  # :json suffix for arrays/objects
swamp workflow run my-workflow --input '{"environment": "production"}'  # legacy single-shot JSON
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

**Output shape:**

```json
{
  "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
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
            {
              "dataId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
              "name": "output",
              "version": 1
            }
          ]
        }
      ],
      "duration": 2
    }
  ],
  "duration": 5,
  "path": "workflows/workflow-3fa85f64-5717-4562-b3fc-2c963f66afa6/workflow-7c9e6679-7425-40de-944b-e07fc1f90ae7-timestamp.yaml"
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
      "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
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
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "workflowId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
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
swamp workflow history logs 7c9e6679-7425-40de-944b-e07fc1f90ae7 --json            # Specific run logs
swamp workflow history logs 7c9e6679-7425-40de-944b-e07fc1f90ae7 build.compile --json  # Specific step logs
```

**Output shape:**

```json
{
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
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
swamp workflow evaluate my-workflow --input environment=dev --json
swamp workflow evaluate --all --json
```

**Key behaviors:**

- CEL expressions (`${{ inputs.X }}`, `${{ model.X.resource... }}`) are resolved
- forEach steps are expanded into concrete steps with resolved `modelIdOrName`,
  `methodName`, inputs, and args
- Vault expressions (`${{ vault.get(...) }}`) remain raw for runtime resolution
- Output saved to `.swamp/workflows-evaluated/` for `--last-evaluated` use

## Concurrency Limits

Add `concurrency: N` at the workflow, job, or step level to cap parallel
execution. Absent or `0` means unbounded. Resolution: step > job > workflow >
unbounded. A `SWAMP_MAX_CONCURRENT_STEPS` env var provides a host-level ceiling.
See
[references/expressions-and-foreach.md](references/expressions-and-foreach.md)
for forEach concurrency examples.

```yaml
concurrency: 10 # workflow level — caps parallel jobs
jobs:
  - name: fan-out
    concurrency: 5 # job level — caps parallel steps
    steps:
      - name: per-item
        forEach:
          item: target
          in: ${{ inputs.targets }}
        concurrency: 3 # step level — caps forEach iterations
        task: {
          type: model_method,
          modelIdOrName: api-client,
          methodName: call,
        }
```

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

**`model_method`** has two mutually exclusive variants — `modelIdOrName`
(existing definition) or `modelType` + `modelName` (direct type execution). See
[references/direct-execution.md](references/direct-execution.md) for details.

```yaml
# Existing definition
task:
  type: model_method
  modelIdOrName: my-model
  methodName: run
  inputs:
    key: ${{ inputs.value }}

# Direct type execution (auto-creates definition)
task:
  type: model_method
  modelType: "@test/greeter"
  modelName: my-greeter
  methodName: greet
  inputs:
    greeting: ${{ inputs.greeting }}
    name: ${{ inputs.who }}
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

Vault expressions are resolved **per-step at execution time** — a step that
writes to a vault makes the new value available to subsequent steps. Example
token-refresh-then-use pattern:

```yaml
jobs:
  refresh:
    steps:
      - name: refresh-token
        task:
          type: model_method
          modelIdOrName: token-refresher
          methodName: refresh
  use-token:
    depends_on: [refresh]
    steps:
      - name: call-api
        task:
          type: model_method
          modelIdOrName: api-client # vault.get() resolved after refresh
          methodName: invoke
```

## Workflow Example

End-to-end workflow creation:

1. **Get schema**: `swamp workflow schema get --json`
2. **Create**: `swamp workflow create my-task --json`
3. **Edit**: Add jobs and steps to the YAML file
4. **Validate**: `swamp workflow validate my-task --json`
5. **Fix** any errors and re-validate
6. **Run**: `swamp workflow run my-task`

## When to Use Other Skills

| Need                       | Use Skill               |
| -------------------------- | ----------------------- |
| Create/run models          | `swamp-model`           |
| Vault management           | `swamp-vault`           |
| Repository structure       | `swamp-repo`            |
| Manage model data          | `swamp-data`            |
| Create custom models       | `swamp-extension`       |
| Understand swamp internals | `swamp-troubleshooting` |

## References

- **CI/CD integration**: See `swamp-repo` skill's
  [references/ci-integration.md](../swamp-repo/references/ci-integration.md) for
  installing swamp in CI and GitHub Actions examples
- **Nested workflows**: See
  [references/nested-workflows.md](references/nested-workflows.md) for when to
  split a workflow into parent + child (reusable sub-processes, shape-validated
  handoffs, independent cadence), full examples of workflows calling other
  workflows, forEach with workflows, and nesting limitations
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
