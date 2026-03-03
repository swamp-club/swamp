# Workflow Scenarios

End-to-end scenarios showing how to build workflows for common use cases.

## Table of Contents

- [Scenario 1: Multi-Step Sequential Workflow](#scenario-1-multi-step-sequential-workflow)
- [Scenario 2: Parallel Execution](#scenario-2-parallel-execution)
- [Scenario 3: forEach Iteration](#scenario-3-foreach-iteration)
- [Scenario 4: Conditional Cleanup](#scenario-4-conditional-cleanup)
- [Scenario 5: Nested Workflows](#scenario-5-nested-workflows)

---

## Scenario 1: Multi-Step Sequential Workflow

### User Request

> "I need to provision a VPC, then subnets, then security groups in order."

### What You'll Build

- 1 workflow with 3 sequential jobs
- Models for VPC, subnet, and security group

### Decision Tree

```
Multiple steps in order → Workflow with job dependencies
Each step creates a resource → Separate models for each
Later steps reference earlier outputs → CEL expressions
```

### Step-by-Step

**1. Create the models first**

```bash
swamp model create @user/vpc networking-vpc --json
swamp model create @user/subnet public-subnet --json
swamp model create @user/security-group app-sg --json
```

Configure each model to reference the previous:

```yaml
# models/public-subnet/input.yaml
name: public-subnet
version: 1
globalArguments:
  vpcId: ${{ model.networking-vpc.resource.vpc.main.attributes.VpcId }}
  cidrBlock: "10.0.1.0/24"
```

```yaml
# models/app-sg/input.yaml
name: app-sg
version: 1
globalArguments:
  vpcId: ${{ model.networking-vpc.resource.vpc.main.attributes.VpcId }}
  subnetId: ${{ model.public-subnet.resource.subnet.primary.attributes.SubnetId }}
```

**2. Create the workflow**

```bash
swamp workflow create provision-networking --json
```

**3. Configure the workflow**

```yaml
# workflows/provision-networking/workflow.yaml
id: provision-networking-id
name: provision-networking
description: Provision complete networking stack
version: 1
jobs:
  - name: create-vpc
    description: Create the VPC first
    steps:
      - name: vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: create

  - name: create-subnet
    description: Create subnets after VPC
    dependsOn:
      - job: create-vpc
        condition:
          type: succeeded
    steps:
      - name: subnet
        task:
          type: model_method
          modelIdOrName: public-subnet
          methodName: create

  - name: create-sg
    description: Create security groups after subnets
    dependsOn:
      - job: create-subnet
        condition:
          type: succeeded
    steps:
      - name: security-group
        task:
          type: model_method
          modelIdOrName: app-sg
          methodName: create
```

**4. Run the workflow**

```bash
swamp workflow run provision-networking --json
```

### CEL Paths Used

| Model         | Expression                                                        |
| ------------- | ----------------------------------------------------------------- |
| public-subnet | `model.networking-vpc.resource.vpc.main.attributes.VpcId`         |
| app-sg        | `model.networking-vpc.resource.vpc.main.attributes.VpcId`         |
| app-sg        | `model.public-subnet.resource.subnet.primary.attributes.SubnetId` |

---

## Scenario 2: Parallel Execution

### User Request

> "I need to run multiple independent lookups at the same time to speed things
> up."

### What You'll Build

- 1 workflow with parallel steps in a single job
- Multiple independent models

### Decision Tree

```
Independent operations → Steps in same job (no step dependencies)
No data dependencies between them → Run in parallel automatically
```

### Step-by-Step

**1. Create independent lookup models**

```bash
swamp model create command/shell ami-lookup --json
swamp model create command/shell vpc-lookup --json
swamp model create command/shell sg-lookup --json
```

**2. Create parallel workflow**

```yaml
# workflows/parallel-lookups/workflow.yaml
id: parallel-lookups-id
name: parallel-lookups
description: Run multiple lookups in parallel
version: 1
jobs:
  - name: lookups
    description: All lookups run in parallel
    steps:
      - name: ami
        task:
          type: model_method
          modelIdOrName: ami-lookup
          methodName: execute

      - name: vpc
        task:
          type: model_method
          modelIdOrName: vpc-lookup
          methodName: execute

      - name: sg
        task:
          type: model_method
          modelIdOrName: sg-lookup
          methodName: execute

  - name: use-results
    description: Use all lookup results
    dependsOn:
      - job: lookups
        condition:
          type: succeeded
    steps:
      - name: create-instance
        task:
          type: model_method
          modelIdOrName: my-instance
          methodName: create
```

**3. Configure the instance model to use all lookups**

```yaml
# models/my-instance/input.yaml
name: my-instance
version: 1
globalArguments:
  imageId: ${{ model.ami-lookup.resource.result.result.attributes.stdout }}
  vpcId: ${{ model.vpc-lookup.resource.result.result.attributes.stdout }}
  securityGroupId: ${{ model.sg-lookup.resource.result.result.attributes.stdout }}
```

---

## Scenario 3: forEach Iteration

### User Request

> "I need to deploy to multiple environments (dev, staging, prod) using the same
> workflow."

### What You'll Build

- 1 workflow with forEach iteration
- 1 model that accepts environment as input

### Decision Tree

```
Same operation for multiple items → forEach
Dynamic list of items → Pass as workflow input
Each iteration needs different values → forEach item variable
```

### Step-by-Step

**1. Create model with inputs schema**

```yaml
# models/deploy-service/input.yaml
name: deploy-service
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
  required: ["environment"]
globalArguments:
  target: ${{ inputs.environment }}
  endpoint: https://api.${{ inputs.environment }}.example.com
```

**2. Create forEach workflow**

```yaml
# workflows/deploy-all-envs/workflow.yaml
id: deploy-all-envs-id
name: deploy-all-envs
description: Deploy to all environments
version: 1
inputs:
  properties:
    environments:
      type: array
      items:
        type: string
      default: ["dev", "staging", "production"]
  required: []
jobs:
  - name: deploy
    description: Deploy to each environment
    steps:
      - name: deploy-${{ self.env }}
        forEach:
          item: env
          in: ${{ inputs.environments }}
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
          inputs:
            environment: ${{ self.env }}
```

**3. Run with default environments**

```bash
swamp workflow run deploy-all-envs --json
```

**4. Run with custom list**

```bash
swamp workflow run deploy-all-envs --input '{"environments": ["dev", "staging"]}' --json
```

### CEL Paths Used

| Context  | Expression            | Value at runtime                   |
| -------- | --------------------- | ---------------------------------- |
| workflow | `inputs.environments` | `["dev", "staging", "production"]` |
| step     | `self.env`            | Current iteration value            |
| model    | `inputs.environment`  | Passed from step                   |

---

## Scenario 4: Conditional Cleanup

### User Request

> "I need a delete workflow that cleans up resources in reverse order, but only
> if the create workflow succeeded."

### What You'll Build

- 1 delete workflow with reverse dependency order
- Job conditions based on resource state

### Decision Tree

```
Delete requires reverse order → dependsOn in reverse
Check if resource exists → Read data first
Handle missing resources gracefully → Conditions or error handling
```

### Step-by-Step

**1. Create delete workflow (reverse of create)**

```yaml
# workflows/delete-networking/workflow.yaml
id: delete-networking-id
name: delete-networking
description: Delete networking in reverse order
version: 1
jobs:
  - name: delete-sg
    description: Delete security groups first (depends on nothing)
    steps:
      - name: sg
        task:
          type: model_method
          modelIdOrName: app-sg
          methodName: delete

  - name: delete-subnet
    description: Delete subnets after SG
    dependsOn:
      - job: delete-sg
        condition:
          type: succeeded
    steps:
      - name: subnet
        task:
          type: model_method
          modelIdOrName: public-subnet
          methodName: delete

  - name: delete-vpc
    description: Delete VPC last
    dependsOn:
      - job: delete-subnet
        condition:
          type: succeeded
    steps:
      - name: vpc
        task:
          type: model_method
          modelIdOrName: networking-vpc
          methodName: delete

  - name: cleanup
    description: Run garbage collection
    dependsOn:
      - job: delete-vpc
        condition:
          type: any_completed
    steps:
      - name: gc
        task:
          type: model_method
          modelIdOrName: gc-runner
          methodName: gc
```

**2. Create models with delete methods**

Each model's delete method reads its own stored data:

```typescript
// In extension model
methods: {
  delete: {
    description: "Delete the resource",
    arguments: z.object({}),
    execute: async (_args, context) => {
      // Read stored data to get resource ID
      const content = await context.dataRepository.getContent(
        context.modelType,
        context.modelId,
        "vpc",
      );

      if (!content) {
        context.logger.info("No VPC found - nothing to delete");
        return { dataHandles: [] };
      }

      const vpcData = JSON.parse(new TextDecoder().decode(content));
      // Delete the resource using vpcData.VpcId
      // ...

      return { dataHandles: [] };
    },
  },
},
```

### Ordering Reference

| Create Order (first → last) | Delete Order (first → last) |
| --------------------------- | --------------------------- |
| 1. VPC                      | 1. Security Groups          |
| 2. Subnets                  | 2. Subnets                  |
| 3. Security Groups          | 3. VPC                      |

---

## Scenario 5: Nested Workflows

### User Request

> "I have a deployment workflow and a notification workflow. I want the
> deployment to automatically notify when done."

### What You'll Build

- 2 workflows: parent (deploy) and child (notify)
- Parent calls child using `type: workflow`

### Decision Tree

```
Reusable workflow component → Separate workflow
Call from another workflow → type: workflow task
Pass data between workflows → inputs
```

### Step-by-Step

**1. Create the notification workflow (child)**

```yaml
# workflows/notify-team/workflow.yaml
id: notify-team-id
name: notify-team
description: Send team notification
version: 1
inputs:
  properties:
    channel:
      type: string
      enum: ["slack", "email"]
      default: "slack"
    message:
      type: string
  required: ["message"]
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

**2. Create the deployment workflow (parent)**

```yaml
# workflows/deploy-and-notify/workflow.yaml
id: deploy-and-notify-id
name: deploy-and-notify
description: Deploy then notify team
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
  required: ["environment"]
jobs:
  - name: deploy
    description: Deploy the application
    steps:
      - name: run-deploy
        task:
          type: model_method
          modelIdOrName: deploy-service
          methodName: deploy
          inputs:
            environment: ${{ inputs.environment }}

  - name: notify-success
    description: Notify on success
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
            message: "Successfully deployed to ${{ inputs.environment }}"

  - name: notify-failure
    description: Notify on failure
    dependsOn:
      - job: deploy
        condition:
          type: failed
    steps:
      - name: send-alert
        task:
          type: workflow
          workflowIdOrName: notify-team
          inputs:
            channel: email
            message: "ALERT: Deployment to ${{ inputs.environment }} failed!"
```

**3. Run the combined workflow**

```bash
swamp workflow run deploy-and-notify --input '{"environment": "production"}' --json
```

### Nested Workflow Limitations

| Limit             | Value | Description                         |
| ----------------- | ----- | ----------------------------------- |
| Max nesting depth | 10    | Prevents infinite recursion         |
| Cycle detection   | Yes   | A → B → A is rejected               |
| Parallel nesting  | Yes   | forEach with nested workflows works |

### CEL Paths Used

| Workflow          | Expression           | Description           |
| ----------------- | -------------------- | --------------------- |
| deploy-and-notify | `inputs.environment` | Parent workflow input |
| notify-team       | `inputs.message`     | Passed from parent    |
| notify-team       | `inputs.channel`     | Passed from parent    |
