# Calling Workflows from Workflows

## Table of Contents

- [Basic Nested Workflow](#basic-nested-workflow)
- [Workflow Task Fields](#workflow-task-fields)
- [Nested Workflow with forEach](#nested-workflow-with-foreach)
- [Data Access in Sub-Workflows](#data-access-in-sub-workflows)
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

## Data Access in Sub-Workflows

Sub-workflow model instances can access data produced by the parent workflow
using either `model.*` or `data.latest()` expressions. Both work for
cross-workflow data access since `type: "resource"` is preserved on
workflow-produced data.

**Example: Parent workflow creates resources, sub-workflow tags them**

```yaml
# create-networking workflow (parent)
jobs:
  - name: create
    steps:
      - name: create-vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: create
  - name: tag
    dependsOn:
      - job: create
        condition:
          type: succeeded
    steps:
      - name: tag-resources
        task:
          type: workflow
          workflowIdOrName: tag-networking
```

The `tag-networking` sub-workflow's model instances can reference the VPC data:

```yaml
# tag-vpc model instance (used by tag-networking workflow)
name: tag-vpc
attributes:
  region: us-east-1
  resourceId: ${{ model.networking-vpc.resource.vpc.main.attributes.VpcId }}
  tagKey: ManagedBy
  tagValue: Swamp
```

See [data-chaining.md](data-chaining.md) for more details on expression choice
and data chaining patterns.

## Limitations

- **Max nesting depth: 10** - prevents infinite recursion
- **Cycle detection** - workflow A calling workflow B calling workflow A is
  rejected with a clear error
- The child workflow run is tracked as a separate run in workflow history
