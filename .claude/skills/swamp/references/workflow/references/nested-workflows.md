# Calling Workflows from Workflows

## Table of Contents

- [When to Use Nested Workflows](#when-to-use-nested-workflows)
- [Basic Nested Workflow](#basic-nested-workflow)
- [Workflow Task Fields](#workflow-task-fields)
- [Nested Workflow with forEach](#nested-workflow-with-foreach)
- [Data Access in Sub-Workflows](#data-access-in-sub-workflows)
- [Approval Gates in a Child Workflow](#approval-gates-in-a-child-workflow)
- [Limitations](#limitations)

Steps can invoke another workflow using `type: workflow`. The parent step waits
for the child workflow to complete before continuing.

## When to Use Nested Workflows

Reach for a child workflow when a flat workflow can't express the shape you
need. The cases that come up in practice:

### 1. Reusable sub-process invoked from multiple parents

When the same sequence of steps runs from a cron parent, a manual run, and
another workflow, extract it into a child workflow with a typed input schema.
Duplicating steps across workflows is the wrong trade — the child gives you one
validated entry point.

### 2. Shape-validated handoff of computed data

When a parent produces a list (or other structured value) that a child should
iterate over, passing it through `task.inputs` with an input schema catches
shape drift at the boundary rather than deep inside the child:

```yaml
# parent — resolve the list and pass it through a typed input
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
          in: ${{ inputs.episodes }}
        task:
          type: model_method
          modelIdOrName: transmission
          methodName: add
          inputs:
            uri: ${{ self.ep.magnet }}
            protocol: torrent
```

This is a design choice about validation and contract, not a workaround.
`forEach.in` can call `data.findBySpec()`, `data.findByTag()`, `data.query()`,
and the other data helpers directly in a flat workflow — the evaluator awaits
async data helpers. Reach for a child workflow when the typed boundary itself is
valuable.

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

`workflowIdOrName` itself can be a `self.*` expression, so each item chooses
which workflow to run — useful when a planner emits items that each name their
implementation:

```yaml
jobs:
  - name: apply-wave
    steps:
      - name: apply-${{ self.item.host }}
        forEach:
          item: item
          in: ${{ inputs.items }}
        task:
          type: workflow
          workflowIdOrName: ${{ self.item.implementation.workflowIdOrName }}
          inputs:
            host: ${{ self.item.host }}
```

With items like
`[{ "host": "gitea", "implementation": { "workflowIdOrName": "lab-capability-ssh" } }]`,
the step targets `lab-capability-ssh`. The resolved target appears in
`--last-evaluated` output.

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

## Approval Gates in a Child Workflow

When a child workflow suspends at a `manual_approval` gate, the parent suspends
too, on the step that runs the child. The child stays an ordinary suspended run:
approve, reject, resume and cancel it under its own workflow name and run id.
Then resume the parent, which reads the child's outcome:

```
swamp workflow approve <child> <gate> --run <child-run-id>
swamp workflow resume  <child> --run <child-run-id>
swamp workflow resume  <parent> --run <parent-run-id>
```

- Resuming the parent while the child is unfinished is refused, naming what the
  child needs (approve, resume, recover or cancel).
- A rejected child fails the parent's step as a rejected approval; a plain retry
  of the parent then refuses, as for a gate of its own.
- `swamp workflow approvals` lists the child's gate; its row names the parent.
- A child that waits for a signal (`wait_for_signal`) suspends the parent the
  same way: `swamp workflow signal <wait-id> --payload '<json>'`, resume the
  child, then resume the parent. The parent's `workflow run` output names the
  wait ID, with and without `--server` (`signalRequired.waitId` and
  `nestedSignalWaits[]` with `--json`), and so does its refusal. A wait further
  down prints the resume of the run that holds it: run that first, then each run
  above it. The parent cannot read the child's payload through
  `steps.<nested>.outputs`.
- Under `swamp serve`, the parent resumes on its own once the child finishes,
  when the parent's auto-resume policy is on and the approver may approve it.
- In `--json` output, the suspended document's `approvalRequired` names the gate
  to decide (`workflowName`, `runId`, `stepId`), and `waitingOnNestedRun` names
  the child the parent waits on.
- Cancelling or rejecting the parent leaves the child as it was. While the child
  is unfinished, the output includes the command that cancels it.
- With mixed swamp versions, approve the child's gate rather than the parent's
  waiting step: an older version approving the parent's step skips the child's
  outputs. A child an older version approved or resumed is still adopted, but
  serve does not resume its parent automatically: resume the parent yourself.

## Limitations

- **Max nesting depth: 10** - prevents infinite recursion
- **Cycle detection** - workflow A calling workflow B calling workflow A is
  rejected with a clear error
- The child workflow run is tracked as a separate run in workflow history
