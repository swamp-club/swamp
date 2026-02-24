# Model Scenarios

End-to-end scenarios showing how to build models for common use cases.

## Table of Contents

- [Scenario 1: Simple Shell Command](#scenario-1-simple-shell-command)
- [Scenario 2: Chained AWS Lookups](#scenario-2-chained-aws-lookups)
- [Scenario 3: Model with Runtime Inputs](#scenario-3-model-with-runtime-inputs)
- [Scenario 4: Multi-Environment Configuration](#scenario-4-multi-environment-configuration)

---

## Scenario 1: Simple Shell Command

### User Request

> "I want to run a shell command and capture its output for use in other
> models."

### What You'll Build

- 1 model: `command/shell` type

### Decision Tree

```
User wants to run a command → Use command/shell model
```

### Step-by-Step

**1. Create the model**

```bash
swamp model create command/shell my-shell --json
```

**2. Configure the model input**

```bash
swamp model get my-shell --json
# Note the path, then edit the file
```

Edit `models/my-shell/input.yaml`:

```yaml
name: my-shell
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: "uname -a"
```

**3. Validate**

```bash
swamp model validate my-shell --json
```

**4. Run**

```bash
swamp model method run my-shell execute --json
```

**5. View output**

```bash
swamp model output get my-shell --json
swamp data get my-shell result --json
```

### CEL Paths Used

| Field    | CEL Path                                                    |
| -------- | ----------------------------------------------------------- |
| stdout   | `model.my-shell.resource.result.result.attributes.stdout`   |
| stderr   | `model.my-shell.resource.result.result.attributes.stderr`   |
| exitCode | `model.my-shell.resource.result.result.attributes.exitCode` |

---

## Scenario 2: Chained AWS Lookups

### User Request

> "I need to look up my default VPC, find a subnet in it, and then create an EC2
> instance using that subnet."

### What You'll Build

- 3 models:
  - `vpc-lookup` (command/shell) — find the default VPC
  - `subnet-lookup` (command/shell) — find a subnet in that VPC
  - `my-instance` (@user/ec2-instance or similar) — uses both

### Decision Tree

```
User wants to chain multiple lookups → Multiple models with CEL references
Each lookup is a command → command/shell model
Final resource needs custom logic → Extension model (or use existing type)
```

### Step-by-Step

**1. Create VPC lookup model**

```bash
swamp model create command/shell vpc-lookup --json
```

Edit `models/vpc-lookup/input.yaml`:

```yaml
name: vpc-lookup
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: >-
        aws ec2 describe-vpcs
        --filters "Name=isDefault,Values=true"
        --query "Vpcs[0].VpcId" --output text
```

Run it:

```bash
swamp model method run vpc-lookup execute --json
```

**2. Create subnet lookup model (references VPC)**

```bash
swamp model create command/shell subnet-lookup --json
```

Edit `models/subnet-lookup/input.yaml`:

```yaml
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

Validate and run:

```bash
swamp model validate subnet-lookup --json
swamp model method run subnet-lookup execute --json
```

**3. Create instance model (references both)**

```bash
swamp model create @user/ec2-instance my-instance --json
```

Edit `models/my-instance/input.yaml`:

```yaml
name: my-instance
version: 1
tags: {}
globalArguments:
  vpcId: ${{ model.vpc-lookup.resource.result.result.attributes.stdout }}
  subnetId: ${{ model.subnet-lookup.resource.result.result.attributes.stdout }}
  instanceType: t3.micro
  tags:
    Name: ${{ self.name }}
    Environment: dev
```

Validate:

```bash
swamp model validate my-instance --json
```

### CEL Paths Used

| Model         | Expression                                                     | Description |
| ------------- | -------------------------------------------------------------- | ----------- |
| vpc-lookup    | `model.vpc-lookup.resource.result.result.attributes.stdout`    | VPC ID      |
| subnet-lookup | `model.subnet-lookup.resource.result.result.attributes.stdout` | Subnet ID   |
| my-instance   | `self.name`                                                    | Model name  |

---

## Scenario 3: Model with Runtime Inputs

### User Request

> "I want a deployment model where I can specify the environment (dev, staging,
> prod) at runtime instead of hardcoding it."

### What You'll Build

- 1 model with `inputs` schema

### Decision Tree

```
User wants runtime parameterization → Use inputs schema
Values change per invocation → --input or --input-file
```

### Step-by-Step

**1. Create the model**

```bash
swamp model create @user/deployment my-deploy --json
```

**2. Configure with inputs schema**

Edit `models/my-deploy/input.yaml`:

```yaml
name: my-deploy
version: 1
tags: {}
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target deployment environment
    replicas:
      type: integer
      default: 1
      minimum: 1
      maximum: 10
    dryRun:
      type: boolean
      default: false
  required: ["environment"]
globalArguments:
  target: ${{ inputs.environment }}
  instanceCount: ${{ inputs.replicas }}
  simulate: ${{ inputs.dryRun }}
methods:
  deploy:
    arguments: {}
```

**3. Validate**

```bash
swamp model validate my-deploy --json
```

**4. Run with different inputs**

```bash
# Dev environment
swamp model method run my-deploy deploy --input '{"environment": "dev"}' --json

# Production with 3 replicas
swamp model method run my-deploy deploy --input '{"environment": "production", "replicas": 3}' --json

# Staging dry run
swamp model method run my-deploy deploy --input '{"environment": "staging", "dryRun": true}' --json
```

**5. Alternative: Use input file**

Create `inputs/production.yaml`:

```yaml
environment: production
replicas: 5
dryRun: false
```

Run with file:

```bash
swamp model method run my-deploy deploy --input-file inputs/production.yaml --json
```

### CEL Paths Used

| Field       | CEL Path             | Runtime Value                        |
| ----------- | -------------------- | ------------------------------------ |
| environment | `inputs.environment` | `"dev"`, `"staging"`, `"production"` |
| replicas    | `inputs.replicas`    | `1`, `3`, `5`, etc.                  |
| dryRun      | `inputs.dryRun`      | `true`, `false`                      |

---

## Scenario 4: Multi-Environment Configuration

### User Request

> "I want to deploy to multiple environments with different configurations. Each
> environment should use its own vault for secrets."

### What You'll Build

- 3 vaults: `dev-secrets`, `staging-secrets`, `prod-secrets`
- 1 model with environment-aware vault expressions

### Decision Tree

```
Different secrets per environment → Multiple vaults
Single model definition → CEL expressions select vault dynamically
```

### Step-by-Step

**1. Create vaults for each environment**

```bash
swamp vault create local_encryption dev-secrets --json
swamp vault create local_encryption staging-secrets --json
swamp vault create aws prod-secrets --json  # Production uses AWS
```

**2. Store secrets in each vault**

```bash
swamp vault put dev-secrets API_KEY=dev-key-12345
swamp vault put staging-secrets API_KEY=staging-key-67890
swamp vault put prod-secrets API_KEY=prod-key-secure
```

**3. Create model with conditional vault access**

Since CEL doesn't support dynamic vault names directly, create separate model
instances per environment:

```yaml
# models/api-client-dev/input.yaml
name: api-client-dev
version: 1
tags:
  environment: dev
globalArguments:
  apiKey: ${{ vault.get("dev-secrets", "API_KEY") }}
  endpoint: https://api.dev.example.com
```

```yaml
# models/api-client-staging/input.yaml
name: api-client-staging
version: 1
tags:
  environment: staging
globalArguments:
  apiKey: ${{ vault.get("staging-secrets", "API_KEY") }}
  endpoint: https://api.staging.example.com
```

```yaml
# models/api-client-prod/input.yaml
name: api-client-prod
version: 1
tags:
  environment: production
globalArguments:
  apiKey: ${{ vault.get("prod-secrets", "API_KEY") }}
  endpoint: https://api.example.com
```

**4. Create a workflow that selects the right model**

```yaml
# workflows/deploy-api/workflow.yaml
name: deploy-api
version: 1
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
  required: ["environment"]
jobs:
  - name: deploy
    steps:
      - name: deploy-dev
        condition: ${{ inputs.environment == "dev" }}
        task:
          type: model_method
          modelIdOrName: api-client-dev
          methodName: deploy
      - name: deploy-staging
        condition: ${{ inputs.environment == "staging" }}
        task:
          type: model_method
          modelIdOrName: api-client-staging
          methodName: deploy
      - name: deploy-prod
        condition: ${{ inputs.environment == "production" }}
        task:
          type: model_method
          modelIdOrName: api-client-prod
          methodName: deploy
```

**5. Run for each environment**

```bash
# Deploy to dev
swamp workflow run deploy-api --input '{"environment": "dev"}' --json

# Deploy to production
swamp workflow run deploy-api --input '{"environment": "production"}' --json
```

### CEL Paths Used

| Model              | Expression                                | Value               |
| ------------------ | ----------------------------------------- | ------------------- |
| api-client-dev     | `vault.get("dev-secrets", "API_KEY")`     | `dev-key-12345`     |
| api-client-staging | `vault.get("staging-secrets", "API_KEY")` | `staging-key-67890` |
| api-client-prod    | `vault.get("prod-secrets", "API_KEY")`    | `prod-key-secure`   |
| All models         | `self.name`                               | Model name          |
