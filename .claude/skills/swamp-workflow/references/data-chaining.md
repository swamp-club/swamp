# Data Chaining in Workflows

## Table of Contents

- [Implicit Dependency Resolution](#implicit-dependency-resolution)
- [Example: Dynamic AMI Lookup Workflow](#example-dynamic-ami-lookup-workflow)
- [Example: Multi-Step Infrastructure Workflow](#example-multi-step-infrastructure-workflow)
- [Choosing model.* vs data.latest() Expressions](#choosing-model-vs-datalatest-expressions)
  - [Why model.* is intra-workflow only](#why-model-is-intra-workflow-only)
  - [Why data.latest() is cross-workflow only](#why-datalatest-is-cross-workflow-only)
  - [Practical guidance](#practical-guidance)
  - [Example: Sub-workflow referencing parent data](#example-sub-workflow-referencing-parent-workflow-data)
  - [Summary](#summary)
- [Resource References](#resource-references)
- [Delete Workflow Ordering](#delete-workflow-ordering)
- [Update Workflow Ordering](#update-workflow-ordering)

The `aws/cli` model enables powerful data chaining in workflows by running AWS
CLI commands and making the output available to other models. This is useful for
dynamic lookups like finding the latest AMI, checking resource state, or
querying AWS for configuration values.

## Implicit Dependency Resolution

When a model input contains an expression like
`${{ model.<name>.resource.<specName>.attributes.<field> }}`, the workflow
engine automatically:

1. Detects the dependency on the referenced model
2. Ensures the referenced model's method runs first
3. Evaluates expressions just-in-time before each step executes

## Example: Dynamic AMI Lookup Workflow

```yaml
id: ec2-with-latest-ami
name: ec2-with-latest-ami
description: Create EC2 instance with dynamically looked-up AMI
version: 1
jobs:
  - name: provision
    description: Provision EC2 with latest Amazon Linux AMI
    steps:
      - name: lookup-ami
        description: Find latest Amazon Linux 2 AMI
        task:
          type: model_method
          modelIdOrName: latest-ami
          methodName: run
      - name: create-instance
        description: Create EC2 instance using looked-up AMI
        task:
          type: model_method
          modelIdOrName: my-instance
          methodName: create
```

### Model Inputs

```yaml
# latest-ami input (aws/cli model)
name: latest-ami
attributes:
  command: >-
    ec2 describe-images --owners amazon
    --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
    --query "sort_by(Images,&CreationDate)[-1]"
  region: us-east-1
  parseJson: true
```

```yaml
# my-instance input (references aws/cli output)
name: my-instance
attributes:
  imageId: ${{ model.latest-ami.resource.data.attributes.json.ImageId }}
  instanceType: t3.micro
```

The workflow engine detects that `my-instance` references
`latest-ami.resource.data.attributes`, creating an implicit dependency.

## Example: Multi-Step Infrastructure Workflow

```yaml
id: full-stack-provision
name: full-stack-provision
description: Provision complete infrastructure with dynamic lookups
version: 1
jobs:
  - name: lookup
    description: Look up existing infrastructure
    steps:
      - name: find-vpc
        task:
          type: model_method
          modelIdOrName: vpc-lookup
          methodName: run
      - name: find-subnet
        task:
          type: model_method
          modelIdOrName: subnet-lookup
          methodName: run
  - name: provision
    description: Create resources using lookup results
    dependsOn:
      - job: lookup
        condition:
          type: succeeded
    steps:
      - name: create-security-group
        task:
          type: model_method
          modelIdOrName: app-security-group
          methodName: create
      - name: create-instance
        task:
          type: model_method
          modelIdOrName: app-server
          methodName: create
```

### Model Inputs for Multi-Step Workflow

```yaml
# vpc-lookup (aws/cli)
name: vpc-lookup
attributes:
  command: ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query "Vpcs[0]"
  parseJson: true
```

```yaml
# subnet-lookup (aws/cli) - chains from vpc-lookup
name: subnet-lookup
attributes:
  command: >-
    ec2 describe-subnets
    --filters "Name=vpc-id,Values=${{ model.vpc-lookup.resource.data.attributes.json.VpcId }}"
    --query "Subnets[0]"
  parseJson: true
```

```yaml
# app-security-group - chains from vpc-lookup
name: app-security-group
attributes:
  vpcId: ${{ model.vpc-lookup.resource.data.attributes.json.VpcId }}
  groupName: app-sg
  description: Security group for application
```

```yaml
# app-server - chains from multiple lookups
name: app-server
attributes:
  imageId: ${{ model.latest-ami.resource.data.attributes.json.ImageId }}
  subnetId: ${{ model.subnet-lookup.resource.data.attributes.json.SubnetId }}
  securityGroupIds:
    - ${{ model.app-security-group.resource.resource.attributes.groupId }}
  instanceType: t3.micro
```

## Choosing `model.*` vs `data.latest()` Expressions

Model instance definitions use CEL expressions to reference other models' data.
The two forms have **different resolution scopes** — they are not
interchangeable.

| Expression                        | Sees current-run data?                              | Sees prior-run data?                                                                                     | Implicit deps? |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------- |
| `model.<name>.resource.<spec>`    | **Yes** — in-memory context updated after each step | **No** — `buildContext()` filters by `type: "resource"` tag, misses workflow-produced `step-output` data | **Yes**        |
| `data.latest("<name>", "<spec>")` | **No** — data functions reflect pre-run state only  | **Yes** — reads persisted data regardless of tags                                                        | **No**         |

**Neither expression type works for both intra-workflow and cross-workflow
simultaneously.** They serve different lifecycle phases.

### Why `model.*` is intra-workflow only

When data is written via a workflow step, the workflow engine tags it with
`type: "step-output"` (not `type: "resource"`). At the start of a new workflow
run, `buildContext()` populates `model.*.resource.*` only for data tagged
`type: "resource"` — so data produced by a previous workflow run is invisible to
`model.*` expressions.

Within the same workflow run, `model.*` works because the execution service
updates the in-memory context directly after each step, bypassing the tag
filter.

`model.*` also creates **implicit step dependencies** — Swamp detects
`model.<name>.resource` references and automatically orders the referencing step
after the step that writes that model's data. This is helpful for create
workflows but causes **cyclic dependency errors** when the execution order is
reversed:

1. Explicit `dependsOn` says: delete subnet first, then delete VPC
2. Implicit dependency (from `model.networking-vpc` in subnet's definition)
   says: VPC step must run before subnet step
3. These two constraints conflict → **cycle detected**

### Why `data.latest()` is cross-workflow only

`data.latest()` resolves from persisted data loaded at workflow start,
regardless of tags. However, the data functions are **not updated** as steps
execute during the current run — they reflect the pre-run state. Data written by
a previous workflow run is visible; data written earlier in the same run is not.

`data.latest()` does **not** create implicit step dependencies, so execution
ordering is fully controlled by explicit `dependsOn`.

### Practical guidance

**Use separate model instances for different lifecycle phases.** The demo
demonstrates this pattern:

- **Create workflow** — model instances use `model.*` for intra-workflow
  chaining (implicit dependencies automatically order VPC → subnets → route
  tables)
- **Tag/delete workflows** — separate model instances use `data.latest()` to
  reference data persisted by the create workflow

```yaml
# networking model instances — used in create-networking workflow
# Uses model.* for intra-workflow chaining with implicit deps
name: public-subnet
attributes:
  vpcId: ${{ model.networking-vpc.resource.vpc.attributes.VpcId }}
  cidrBlock: "10.0.1.0/24"
```

```yaml
# tagger model instances — used in tag-networking workflow
# Uses data.latest() to read data persisted by a prior create run
name: tag-vpc
attributes:
  resourceId: ${{ data.latest("networking-vpc", "vpc").attributes.VpcId }}
  tagKey: ManagedBy
  tagValue: Swamp
```

```yaml
# delete workflow — uses job-level dependsOn for ordering
# Delete methods read their own stored data via context.dataRepository,
# not via CEL expressions, so no cross-model expressions are needed
```

### Example: Sub-workflow referencing parent workflow data

A workflow can invoke another workflow using `task: type: workflow`. The
sub-workflow's model instances must use `data.latest()` to reference data
produced by the parent workflow's steps — `model.*` cannot see that data because
of the `step-output` tag filtering.

```yaml
# create-networking workflow
jobs:
  - name: create
    description: Create VPC, subnets, IGW, and route tables
    steps:
      - name: create-vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: create
      # ... more create steps ...
    dependsOn: []
  - name: tag
    description: Tag all created resources
    steps:
      - name: tag-resources
        task:
          type: workflow
          workflowIdOrName: tag-networking
    dependsOn:
      - job: create
        condition:
          type: succeeded
```

The `tag-networking` sub-workflow's model instances use `data.latest()`:

```yaml
# tag-vpc model instance — uses data.latest() to reference VPC data
# from the create workflow
name: tag-vpc
attributes:
  region: us-east-1
  resourceId: ${{ data.latest("networking-vpc", "vpc").attributes.VpcId }}
  tagKey: ManagedBy
  tagValue: Swamp
```

### Summary

| Scenario                                                        | Expression               | Why                                                    |
| --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| Intra-workflow chaining (create VPC → create subnet)            | `model.*`                | Sees current-run data, implicit deps handle ordering   |
| Cross-workflow reference (tag/delete/update reading prior data) | `data.latest()`          | Sees persisted data regardless of tags                 |
| Sub-workflow reading parent data                                | `data.latest()`          | `model.*` can't see `step-output` tagged data          |
| Update/delete methods reading own stored data                   | `context.dataRepository` | Direct API access in model code, no expressions needed |

## Resource References

All model data outputs are accessed via
`model.<name>.resource.<specName>.attributes.<field>`:

| Model Type    | Spec Name  | Example                                                  |
| ------------- | ---------- | -------------------------------------------------------- |
| aws/cli       | `data`     | `model.ami-lookup.resource.data.attributes.json.ImageId` |
| Cloud Control | `resource` | `model.my-vpc.resource.resource.attributes.VpcId`        |
| Custom models | (varies)   | `model.my-deploy.resource.state.attributes.endpoint`     |

## Delete Workflow Ordering

Delete workflows require **explicit `dependsOn`** in reverse dependency order.
Unlike create workflows where CEL expressions (e.g.,
`${{ model.vpc.resource.vpc.attributes.VpcId }}`) create implicit dependencies,
delete methods read their own stored data via `context.dataRepository` — not
other models' data via expressions. There are no expression-based references to
trigger implicit dependency detection, so you must declare the ordering
explicitly.

The dependency graph for a delete workflow is the **reverse** of the create
workflow.

### Example: Delete Networking

```yaml
id: delete-networking
name: delete-networking
description: Delete all networking resources in reverse dependency order
version: 1
jobs:
  - name: delete-route-tables
    description: Disassociate and delete route tables first
    steps:
      - name: delete-public-route-table
        task:
          type: model_method
          modelIdOrName: public-route-table
          methodName: delete
      - name: delete-private-route-table
        task:
          type: model_method
          modelIdOrName: private-route-table
          methodName: delete
    dependsOn: []

  - name: delete-subnets-and-igw
    description: Delete subnets and internet gateway
    steps:
      - name: delete-public-subnet
        task:
          type: model_method
          modelIdOrName: public-subnet
          methodName: delete
      - name: delete-private-subnet
        task:
          type: model_method
          modelIdOrName: private-subnet
          methodName: delete
      - name: delete-igw
        task:
          type: model_method
          modelIdOrName: networking-igw
          methodName: delete
    dependsOn:
      - job: delete-route-tables
        condition:
          type: succeeded

  - name: delete-vpc
    description: Delete the VPC last
    steps:
      - name: delete-vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: delete
    dependsOn:
      - job: delete-subnets-and-igw
        condition:
          type: succeeded
```

**Ordering rationale** (reverse of create):

| Create order (first → last) | Delete order (first → last) |
| --------------------------- | --------------------------- |
| 1. VPC                      | 1. Route tables             |
| 2. Subnets, IGW             | 2. Subnets, IGW             |
| 3. Route tables             | 3. VPC                      |

**Key points:**

- Use **job-level `dependsOn`** to enforce ordering between groups of deletions
- Each delete method reads its own stored data — no cross-model CEL references
- Steps within a job can run in parallel (e.g., public and private subnets
  delete concurrently)
- Always delete dependent resources before the resources they depend on (e.g.,
  route tables before subnets, subnets before VPC)

## Update Workflow Ordering

Update workflows follow the **same dependency order as create** — update the
foundation first, then dependents. Like delete workflows, update methods read
their own stored data via `context.dataRepository` and don't reference other
models via CEL expressions, so you need **explicit `dependsOn`**.

The key difference from delete: update methods call `writeResource()` to persist
the updated state (creating a new version), so the stored data stays current for
subsequent workflows.

```yaml
id: update-networking
name: update-networking
description: Update networking resources (e.g., enable DNS, modify tags)
version: 1
jobs:
  - name: update-vpc
    description: Update VPC attributes first
    steps:
      - name: update-vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: update
    dependsOn: []

  - name: update-subnets-and-igw
    description: Update subnets and internet gateway
    steps:
      - name: update-public-subnet
        task:
          type: model_method
          modelIdOrName: public-subnet
          methodName: update
      - name: update-private-subnet
        task:
          type: model_method
          modelIdOrName: private-subnet
          methodName: update
    dependsOn:
      - job: update-vpc
        condition:
          type: succeeded

  - name: update-route-tables
    description: Update route tables last
    steps:
      - name: update-public-route-table
        task:
          type: model_method
          modelIdOrName: public-route-table
          methodName: update
      - name: update-private-route-table
        task:
          type: model_method
          modelIdOrName: private-route-table
          methodName: update
    dependsOn:
      - job: update-subnets-and-igw
        condition:
          type: succeeded
```

**Ordering across lifecycle phases:**

| Phase  | Dependency order             | Method pattern                                        |
| ------ | ---------------------------- | ----------------------------------------------------- |
| Create | Forward (VPC → subnets → RT) | Write new data via `writeResource()`                  |
| Update | Forward (VPC → subnets → RT) | Read stored data, modify, write via `writeResource()` |
| Tag    | Any order (parallel OK)      | Read persisted data via `data.latest()`               |
| Delete | Reverse (RT → subnets → VPC) | Read stored data, clean up, return empty handles      |
