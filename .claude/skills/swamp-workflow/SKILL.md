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
| Run a workflow    | `swamp workflow run <id_or_name> --json`               |
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
          ref: build
    steps:
      - name: upload
        description: Upload artifacts
        task:
          type: shell
          command: ./deploy.sh
```

## Edit a Workflow

Open workflow file in your editor.

```bash
swamp workflow edit my-workflow
```

Without arguments, shows a search interface to select a workflow.

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
```

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
        { "name": "example", "status": "succeeded", "duration": 2 }
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
