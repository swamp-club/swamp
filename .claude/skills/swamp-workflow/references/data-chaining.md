# Data Chaining in Workflows

## Table of Contents

- [Example: Dynamic AMI Lookup Workflow](#example-dynamic-ami-lookup-workflow)
- [Example: Multi-Step Infrastructure Workflow](#example-multi-step-infrastructure-workflow)
- [Choosing model.\* vs data.latest() Expressions](#choosing-model-vs-datalatest-expressions)
- [Resource References](#resource-references)
- [Delete Workflow Ordering](#delete-workflow-ordering)
- [Update Workflow Ordering](#update-workflow-ordering)

The `command/shell` model enables powerful data chaining in workflows by running
shell commands and making the output available to other models. This is useful
for dynamic lookups like finding the latest AMI, checking resource state, or
querying AWS for configuration values.

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
          methodName: execute
      - name: create-instance
        description: Create EC2 instance using looked-up AMI
        task:
          type: model_method
          modelIdOrName: my-instance
          methodName: create
```

### Model Inputs

```yaml
# latest-ami input (command/shell model)
name: latest-ami
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-images --owners amazon
        --filters "Name=name,Values=amzn2-ami-hvm-*-x86_64-gp2"
        --query "sort_by(Images,&CreationDate)[-1].ImageId"
        --output text
```

```yaml
# my-instance input (references command/shell output)
name: my-instance
version: 1
tags: {}
globalArguments:
  imageId: ${{ model.latest-ami.resource.result.result.attributes.stdout }}
  instanceType: t3.micro
```

Use `dependsOn` to ensure step B runs after step A when B references A's output.

## Choosing `model.*` vs `data.latest()` Expressions

Model instance definitions use CEL expressions to reference other models' data.
Both expression forms work for cross-workflow data access, but they have
different characteristics:

| Expression                        | Sees current-run data?                              | Sees prior-run data?                              |
| --------------------------------- | --------------------------------------------------- | ------------------------------------------------- |
| `model.<name>.resource.<spec>`    | **Yes** — in-memory context updated after each step | **Yes** — reads persisted data with `type` intact |
| `data.latest("<name>", "<spec>")` | **No** — snapshot taken at workflow start           | **Yes** — reads persisted data regardless of tags |

### When to use each

**Use `model.*`** for most cases:

- Intra-workflow chaining (step B reads step A's output in the same run)
- Cross-workflow chaining (workflow B reads data from prior workflow A run)

**Use `data.latest()`** when:

- You need to query data by model name dynamically
- You want a snapshot from workflow start rather than live in-memory context

Both forms are equivalent for dependency purposes — use explicit `dependsOn` to
control step ordering.

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
          methodName: execute
      - name: find-subnet
        task:
          type: model_method
          modelIdOrName: subnet-lookup
          methodName: execute
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
# vpc-lookup (command/shell)
name: vpc-lookup
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-vpcs --filters "Name=isDefault,Values=true"
        --query "Vpcs[0].VpcId" --output text
```

```yaml
# subnet-lookup (command/shell) - chains from vpc-lookup
name: subnet-lookup
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-subnets
        --filters "Name=vpc-id,Values=${{ model.vpc-lookup.resource.result.result.attributes.stdout }}"
        --query "Subnets[0].SubnetId" --output text
```

```yaml
# app-security-group - chains from vpc-lookup
name: app-security-group
version: 1
tags: {}
globalArguments:
  vpcId: ${{ model.vpc-lookup.resource.result.result.attributes.stdout }}
  groupName: app-sg
  description: Security group for application
```

```yaml
# app-server - chains from multiple lookups
name: app-server
version: 1
tags: {}
globalArguments:
  imageId: ${{ model.latest-ami.resource.result.result.attributes.stdout }}
  subnetId: ${{ model.subnet-lookup.resource.result.result.attributes.stdout }}
  securityGroupIds:
    - ${{ model.app-security-group.resource.resource.main.attributes.groupId }}
  instanceType: t3.micro
```

## Resource References

All model data outputs are accessed via
`model.<name>.resource.<specName>.<instanceName>.attributes.<field>`:

| Model Type    | Spec Name  | Example                                                      |
| ------------- | ---------- | ------------------------------------------------------------ |
| command/shell | `result`   | `model.ami-lookup.resource.result.result.attributes.stdout`  |
| Cloud Control | `resource` | `model.my-vpc.resource.resource.main.attributes.VpcId`       |
| Custom models | (varies)   | `model.my-deploy.resource.state.current.attributes.endpoint` |

## Delete Workflow Ordering

Delete workflows require **explicit `dependsOn`** in reverse dependency order.
Delete methods read their own stored data via `context.dataRepository` — not
other models' data via expressions.

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
| Delete | Reverse (RT → subnets → VPC) | Read stored data, clean up, return empty handles      |
