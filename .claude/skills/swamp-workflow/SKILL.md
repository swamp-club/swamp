---
name: swamp-workflow
description: Work with swamp workflows for AI-native automation. Use when searching for workflows, creating new workflows, validating workflow definitions, or running workflows. Triggers on requests involving "swamp workflow", "workflow", "run workflow", or "create workflow".
---

# Swamp Workflow Skill

Work with swamp workflows through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task              | Command                                       |
| ----------------- | --------------------------------------------- |
| Get schema        | `swamp workflow schema get --json`            |
| Search workflows  | `swamp workflow search [query] --json`        |
| Get a workflow    | `swamp workflow get <id_or_name> --json`      |
| Create a workflow | `swamp workflow create <name> --json`         |
| Validate workflow | `swamp workflow validate [id_or_name] --json` |
| Run a workflow    | `swamp workflow run <id_or_name> --json`      |

## IMPORTANT: Always Get Schema First

Before creating or editing a workflow file, ALWAYS get the schema first:

```bash
swamp workflow schema get --json
```

This ensures you understand the exact structure and constraints for valid
workflow files.

## Get Workflow Schema

Get the complete JSON Schema for workflow files.

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

**Key schemas:**

- `workflow` - Top-level structure with id, name, description, jobs, version
- `job` - Job definition with name, steps, dependsOn, weight
- `jobDependency` - Job dependency with target job name and trigger condition
- `step` - Step definition with name, task, dependsOn, weight
- `stepDependency` - Step dependency with target step name and trigger condition
- `stepTask` - Discriminated union: `type: "shell"` or `type: "model_method"`
- `triggerCondition` - Conditions like `always`, `succeeded(ref)`,
  `failed(ref)`, etc.

## Search for Workflows

Find existing workflows in the repository.

```bash
swamp workflow search --json
swamp workflow search "deploy" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    { "id": "abc-123", "name": "my-workflow", "jobCount": 2 }
  ]
}
```

Select the workflow whose `name` best matches the user's intent.

## Get a Workflow

Get full details of a specific workflow including jobs and steps.

```bash
swamp workflow get my-workflow --json
```

**Output shape:**

```json
{
  "id": "abc-123",
  "name": "my-workflow",
  "version": 1,
  "jobs": [
    {
      "name": "main",
      "description": "Main job",
      "steps": [
        {
          "name": "example",
          "description": "Example step",
          "task": {
            "type": "shell",
            "command": "echo",
            "args": ["Hello!"]
          }
        }
      ]
    }
  ],
  "path": "workflows/workflow-abc-123.yaml"
}
```

**Key fields:**

- `jobs` - Array of jobs that run in the workflow
- `steps` - Steps within each job (run sequentially by default)
- `path` - File path to read/edit the workflow definition

## Create a Workflow

Create a new workflow file.

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

**Example workflow file structure:**

```yaml
# workflows/workflow-abc-123.yaml
apiVersion: swamp/v1
kind: Workflow
metadata:
  id: abc-123
  name: my-deploy-workflow
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
    needs: [build]
    steps:
      - name: upload
        description: Upload artifacts
        task:
          type: shell
          command: ./deploy.sh
```

## Validate Workflows

Validate a specific workflow or all workflows against their schemas.

**Validate a single workflow:**

```bash
swamp workflow validate my-workflow --json
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

**Validate all workflows:**

```bash
swamp workflow validate --json
```

**Output shape (all):**

```json
{
  "workflows": [
    { "workflowId": "abc-123", "workflowName": "my-workflow", "validations": [...], "passed": true }
  ],
  "totalPassed": 1,
  "totalFailed": 0,
  "passed": true
}
```

Always validate after editing a workflow file to catch errors early.

## Run a Workflow

Execute a workflow and get execution results.

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

**Key fields:**

- `status` - Overall workflow status: `succeeded`, `failed`, or `running`
- `jobs[].status` - Individual job status
- `jobs[].steps[].status` - Individual step status
- `duration` - Execution time in milliseconds
- `path` - Path to the workflow run log file

After running, summarize results to the user including which jobs/steps
succeeded or failed and their durations.

## Expressions in Workflows

Model inputs can contain CEL expressions using the `${{ <expression> }}` syntax.
When expressions reference `model.<name>.resource.attributes.*`, they create
**implicit step dependencies**.

### Automatic Dependency Resolution

Workflow execution automatically:

1. Detects resource dependencies in expressions
2. Ensures dependent steps run after the step that creates the resource
3. Evaluates expressions just-in-time before each step executes

### Example with Implicit Dependencies

```yaml
# vpc-input has no expressions
# subnet-input has: vpcId: ${{ model.vpc-input.resource.attributes.vpcId }}

jobs:
  - name: main
    steps:
      - name: create-subnet # Listed first but runs second!
        task:
          type: model_method
          modelIdOrName: subnet-input
          methodName: create
      - name: create-vpc
        task:
          type: model_method
          modelIdOrName: vpc-input
          methodName: create
# create-vpc runs first due to implicit dependency from expression
```

In this example, `subnet-input` references
`vpc-input.resource.attributes.vpcId`. The workflow engine detects this and
ensures `create-vpc` runs before `create-subnet`, regardless of their declared
order.

## Workflow Example

End-to-end workflow for creating and running a new workflow:

1. **Get schema**: `swamp workflow schema get --json` (understand valid
   structure)
2. **Create** a new workflow: `swamp workflow create my-task --json`
3. **Edit** the YAML file at the returned `path` to add jobs and steps
4. **Validate** the workflow: `swamp workflow validate my-task --json`
5. **Fix** any validation errors and re-validate
6. **Run** the workflow: `swamp workflow run my-task --json`
