# Calling Workflows from Workflows

## Table of Contents

- [When to Use Nested Workflows](#when-to-use-nested-workflows)
- [Basic Nested Workflow](#basic-nested-workflow)
- [Workflow Task Fields](#workflow-task-fields)
- [Nested Workflow with forEach](#nested-workflow-with-foreach)
- [Data Access in Sub-Workflows](#data-access-in-sub-workflows)
- [Limitations](#limitations)

Steps can invoke another workflow using `type: workflow`. The parent step waits
for the child workflow to complete before continuing.

## When to Use Nested Workflows

Reach for a child workflow when a flat workflow can't express the shape you
need. The cases that come up in practice:

### 1. forEach over an async list (`data.latest()`, `data.findByTag()`, etc.)

`forEach.in` is evaluated **synchronously** at expansion time. CEL expressions
that return a `Promise` — `data.latest()`, `data.findByTag()`,
`data.findBySpec()` — never resolve in this position, and forEach fails with
`forEach.in must evaluate to an array or object, got: object` (the "object" is
the unresolved Promise).

Task `inputs:` ARE awaited for both `model_method` and `workflow` tasks. Move
the async call into the parent's `task.inputs` and let the child iterate over a
plain `inputs.<name>`:

```yaml
# parent — task.inputs awaits data.latest() before invoking child
- name: download
  task:
    type: workflow
    workflowIdOrName: download-episodes
    inputs:
      episodes: ${{ data.latest("dedup", "current").attributes.episodes }}
```

```yaml
# child — declares episodes as an array input
inputs:
  properties:
    episodes:
      type: array
      items: { type: object }
  required: ["episodes"]

jobs:
  - name: download
    steps:
      - name: download-${{ self.ep.show }}
        forEach:
          item: ep
          in: ${{ inputs.episodes }} # already resolved — sync eval is fine
        task:
          type: model_method
          modelIdOrName: transmission
          methodName: add
          inputs:
            uri: ${{ self.ep.magnet }}
            protocol: torrent
```

The child's input schema validates the boundary, so shape drift between producer
and consumer is caught at invoke time.

### 2. Reusable sub-process invoked from multiple parents

When the same sequence of steps runs from a cron parent, a manual run, and
another workflow, extract it into a child workflow with a typed input schema.
Duplicating steps across workflows is the wrong trade — the child gives you one
validated entry point.

### 3. Independent cadence or isolation

A child workflow can carry its own `trigger.schedule` and still be invoked by a
parent. Splitting lets the child run independently — useful for backfill, manual
replays, and tests — without dragging the parent's prelude along.

### When NOT to nest

- **Pure ordering within a single run** → use `dependsOn` between jobs or steps.
  A workflow boundary is not an ordering primitive.
- **Sharing a single resolved value across steps** → reference it directly via
  CEL in each step's inputs; don't pay the boundary cost.
- **Nesting depth pressure** — the cap is 10. Each level should earn its keep.

## Basic Nested Workflow

**Child workflow** (`notify-team`):

```yaml
id: e7f8a9b0-c1d2-4e3f-a4b5-c6d7e8f9a0b1
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
id: 3fa85f64-5717-4562-b3fc-2c963f66afa6
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
