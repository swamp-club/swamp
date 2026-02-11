# Calling Workflows from Workflows

## Table of Contents

- [Basic Nested Workflow](#basic-nested-workflow)
- [Workflow Task Fields](#workflow-task-fields)
- [Nested Workflow with forEach](#nested-workflow-with-foreach)
- [Expression Choice for Sub-Workflows](#expression-choice-for-sub-workflows)
- [Limitations](#limitations)

Steps can invoke another workflow using `type: workflow`. The parent step waits
for the child workflow to complete before continuing.

## Basic Nested Workflow

**Child workflow** (`notify-team`):

```yaml
id: def-456
name: notify-team
description: Send notifications to the team
inputs:
  properties:
    channel:
      type: string
      enum: ["slack", "email"]
    message:
      type: string
  required: ["channel", "message"]
jobs:
  - name: send
    steps:
      - name: dispatch
        task:
          type: model_method
          modelIdOrName: notification-sender
          methodName: send
          inputs:
            channel: ${{ inputs.channel }}
            message: ${{ inputs.message }}
```

**Parent workflow** (`deploy-and-notify`):

```yaml
id: abc-123
name: deploy-and-notify
description: Deploy then notify the team
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
  required: ["environment"]
jobs:
  - name: deploy
    steps:
      - name: run-deploy
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
          inputs:
            environment: ${{ inputs.environment }}
  - name: notify
    dependsOn:
      - job: deploy
        condition:
          type: succeeded
    steps:
      - name: send-notification
        task:
          type: workflow
          workflowIdOrName: notify-team
          inputs:
            channel: slack
            message: "Deployed to ${{ inputs.environment }}"
```

## Workflow Task Fields

| Field              | Required | Description                          |
| ------------------ | -------- | ------------------------------------ |
| `type`             | Yes      | Must be `workflow`                   |
| `workflowIdOrName` | Yes      | Name or UUID of the workflow to call |
| `inputs`           | No       | Input values to pass to the workflow |

## Nested Workflow with forEach

Invoke a workflow for each item in a list:

```yaml
jobs:
  - name: deploy-all
    steps:
      - name: deploy-${{ self.env }}
        forEach:
          item: env
          in: ${{ inputs.environments }}
        task:
          type: workflow
          workflowIdOrName: deploy-single-env
          inputs:
            environment: ${{ self.env }}
```

## Expression Choice for Sub-Workflows

Sub-workflow model instances **must** use `data.latest()` instead of `model.*`
to reference data produced by the parent workflow. `model.*` cannot see data
from prior workflow steps because workflow-produced data is tagged
`step-output`, which `buildContext()` filters out when populating
`model.*.resource.*`. Only `data.latest()` reads persisted data regardless of
tags. See [data-chaining.md](data-chaining.md) for the full scoping rules and a
concrete example using a tag-networking sub-workflow.

## Limitations

- **Max nesting depth: 10** - prevents infinite recursion
- **Cycle detection** - workflow A calling workflow B calling workflow A is
  rejected with a clear error
- The child workflow run is tracked as a separate run in workflow history
