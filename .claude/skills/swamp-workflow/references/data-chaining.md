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

## Choosing Data Accessors vs `model.*` Expressions

Model instance definitions use CEL expressions to reference other models' data.
The `data.*` namespace is the current accessor; `model.*.resource` and
`model.*.file` are deprecated and will be removed in a future release.

Inside the `data.*` namespace, `data.query()` is the primitive and the other
helpers (`data.latest`, `data.version`, `data.findByTag`, `data.findBySpec`,
`data.listVersions`) are shortcuts for common predicates. Prefer a shortcut when
your intent matches — `data.latest("m", "n")` reads more clearly than the
equivalent predicate. Reach for `data.query()` when you need a multi-field
predicate, a projection, or history access.

| Expression                            | Sees current-run data?       | Sees prior-run data? | Status         |
| ------------------------------------- | ---------------------------- | -------------------- | -------------- |
| `data.query('<predicate>')`           | **Yes** — sync catalog query | **Yes**              | **Primary**    |
| `data.latest("<name>", "<spec>")`     | **Yes** — shortcut for query | **Yes**              | **Shortcut**   |
| `data.version("<name>", "<spec>", N)` | **Yes** — shortcut for query | **Yes**              | **Shortcut**   |
| `model.<name>.resource.<spec>`        | **Yes** — eagerly populated  | **Yes**              | **Deprecated** |

### When to use each

**Use a shortcut (`data.latest` / `data.version` / `data.findBySpec` / etc.)**
when your access pattern fits a shortcut. This covers the majority of
cross-model data reads: "give me the latest X/Y", "give me version 2 of X/Y",
"give me every instance from spec S".

**Use `data.query()` directly** when you need a predicate beyond a single
model+name pair — for example, "every failed resource tagged env=prod", "every
record across workflows tagged role=manifest", or a projection that extracts
just specific fields.

**Avoid `model.*.resource` / `model.*.file`** — these patterns are deprecated
and will emit a warning. Migrate to `data.latest()` or `data.query()`.

Use explicit `dependsOn` to control step ordering.

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

## Vary Dimensions for Environment Isolation

When a forEach step produces data per environment, use `vary` on
`dataOutputOverrides` to isolate each environment's data with its own versioning
and `latest` symlink.

### Workflow YAML

```yaml
steps:
  - name: scan-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: scanner
      methodName: execute
      inputs:
        environment: ${{ self.env }}
    dataOutputOverrides:
      - specName: result
        vary:
          - environment
```

### Accessing Varied Data

In a downstream forEach step, use the iteration variable to dynamically access
the correct environment's data:

```yaml
steps:
  - name: report-${{ self.env }}
    forEach:
      item: env
      in: ${{ inputs.environments }}
    task:
      type: model_method
      modelIdOrName: reporter
      methodName: summarize
      inputs:
        environment: ${{ self.env }}
        # Dynamically access this environment's scan result:
        scanResult: ${{ data.latest('scanner', 'result', [self.env]).attributes.count }}
```

For hardcoded access (e.g., in a non-forEach step that needs a specific
environment's data):

```yaml
inputs:
  scanCount: ${{ data.latest('scanner', 'result', [inputs.environment]).attributes.count }}
```

The `vary` field lists input key names (matching keys in `task.inputs`). Their
resolved values are appended to the data instance name with hyphens, producing
names like `result-prod` or `result-dev-us-east-1`.

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
id: d2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f6a
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

## Factory Model Patterns

The factory pattern uses one model definition with `inputs` to create multiple
named instances. Instead of maintaining 4 separate subnet model definitions, you
define one `prod-subnet` model and call it 4 times with different inputs.

For a complete walkthrough, see the
[swamp-model scenarios](../../swamp-model/references/scenarios.md#scenario-5-factory-pattern-for-model-reuse).

### Calling One Model Multiple Times

Steps within a job run in parallel. Each step calls the same `modelIdOrName`
with different inputs.

> **Lock contention:** Steps targeting the **same model** serialize on the
> per-model lock — they won't actually run in parallel. For true parallelism,
> use separate model instances (factory pattern) so each instance holds its own
> lock. This matters most for long-running methods like builds or deployments.

Example:

```yaml
jobs:
  - name: create-subnets
    steps:
      - name: create-public-a
        task:
          type: model_method
          modelIdOrName: prod-subnet
          methodName: create
          inputs:
            instanceName: public-a
            cidrBlock: "10.0.1.0/24"
            availabilityZone: us-east-1a
      - name: create-public-b
        task:
          type: model_method
          modelIdOrName: prod-subnet
          methodName: create
          inputs:
            instanceName: public-b
            cidrBlock: "10.0.2.0/24"
            availabilityZone: us-east-1b
```

The `instanceName` input flows into `name: ${{ inputs.instanceName }}` in the
model's globalArguments, which sets the data instance name. This is how one
model produces separately addressable data instances.

### Referencing Factory Instance Data Downstream

Each factory call creates a distinct data instance keyed by `instanceName`. Use
`data.latest()` with the instance name to reference specific outputs:

```yaml
jobs:
  - name: create-route-tables
    dependsOn:
      - job: create-subnets
        condition:
          type: succeeded
    steps:
      - name: create-public-rt
        task:
          type: model_method
          modelIdOrName: prod-route-table
          methodName: create
          inputs:
            instanceName: public-rt
            subnetId: ${{ data.latest("prod-subnet", "public-a").attributes.SubnetId }}
```

### Delete Steps for Factory Models

Delete steps must provide `instanceName` because the `name` globalArgument
(`name: ${{ inputs.instanceName }}`) determines which data instance to read and
delete. Other inputs are only required if the delete method's implementation
accesses those globalArguments at runtime.

The system **selectively evaluates** globalArgument expressions — inputs that
aren't provided are skipped, and a runtime error only occurs if the method code
actually tries to access an unresolved value.

**What breaks — missing `instanceName`:**

```yaml
# WRONG: No instanceName, so the system can't resolve which data instance to use
- name: delete-public-a
  task:
    type: model_method
    modelIdOrName: prod-subnet
    methodName: delete
    inputs:
      identifier: ${{ data.latest("prod-subnet", "public-a").attributes.SubnetId }}
```

**What works — `instanceName` provided:**

```yaml
# CORRECT: instanceName resolves the name globalArgument and keys the data instance
- name: delete-public-a
  task:
    type: model_method
    modelIdOrName: prod-subnet
    methodName: delete
    inputs:
      instanceName: public-a
      identifier: ${{ data.latest("prod-subnet", "public-a").attributes.SubnetId }}
```

Whether you also need `cidrBlock`, `availabilityZone`, or other create-time
inputs depends on your delete method implementation. If the method code accesses
`globalArgs.CidrBlock`, you must provide `cidrBlock`. If it doesn't, the
unresolved expression is silently skipped.
