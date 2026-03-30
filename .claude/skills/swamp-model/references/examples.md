# Model Examples and CEL Reference

## Table of Contents

- [CEL Expression Quick Reference](#cel-expression-quick-reference)
- [Decision Tree: What to Build](#decision-tree-what-to-build)
- [Simple Shell Command Model](#simple-shell-command-model)
- [Chained Lookup Models](#chained-lookup-models)
- [Model with Runtime Inputs](#model-with-runtime-inputs)
- [Cross-Model Data References](#cross-model-data-references)

## CEL Expression Quick Reference

| Expression Pattern                                           | Description                               | Example Value                 |
| ------------------------------------------------------------ | ----------------------------------------- | ----------------------------- |
| `data.latest("<model>", "<name>").attributes.<field>`        | Latest data (PREFERRED, sync disk read)   | VPC ID, subnet CIDR, etc.     |
| `data.version("<model>", "<name>", N).attributes.<field>`    | Specific version of data                  | Rollback to version 1         |
| `data.findBySpec("<model>", "<spec>")`                       | Find all instances from a spec            | All subnets from scanner      |
| `data.findByTag("<key>", "<value>")`                         | Find data by tag                          | All resources tagged env=prod |
| `model.<name>.resource.<spec>.<instance>.attributes.<field>` | Cross-model resource (DEPRECATED)         | VPC ID, subnet CIDR, etc.     |
| `model.<name>.resource.result.result.attributes.stdout`      | command/shell stdout (DEPRECATED)         | AMI ID from aws cli command   |
| `model.<name>.file.<spec>.<instance>.path`                   | File path from another model (DEPRECATED) | `/path/to/file.txt`           |
| `self.name`                                                  | Current model's name                      | `my-vpc`                      |
| `self.version`                                               | Current model's version                   | `1`                           |
| `self.globalArguments.<field>`                               | This model's own global argument          | CIDR block, region, etc.      |
| `inputs.<name>`                                              | Runtime input value                       | `production`, `true`, etc.    |
| `env.<VAR_NAME>`                                             | Environment variable                      | AWS region, credentials       |
| `vault.get("<vault>", "<key>")`                              | Vault secret                              | API key, password             |

### CEL Path Patterns by Model Type

| Model Type      | Resource Spec | Instance    | CEL Path Example                                              |
| --------------- | ------------- | ----------- | ------------------------------------------------------------- |
| `command/shell` | `result`      | `result`    | `model.my-shell.resource.result.result.attributes.stdout`     |
| `@user/vpc`     | `vpc`         | `main`      | `model.my-vpc.resource.vpc.main.attributes.VpcId`             |
| `@user/subnet`  | `subnet`      | `primary`   | `model.my-subnet.resource.subnet.primary.attributes.SubnetId` |
| Factory model   | `<spec>`      | `<dynamic>` | `model.scanner.resource.subnet.subnet-aaa.attributes.cidr`    |

## Decision Tree: What to Build

```
What does the user want to accomplish?
│
├── Run a single command or API call
│   └── Create a swamp model (command/shell or @user/custom)
│
├── Orchestrate multiple steps in order
│   └── Create a swamp workflow with jobs and steps
│
├── Need custom capabilities not in existing types
│   └── Create an extension model (@user/my-type) in extensions/models/
│
└── Combine all of the above
    └── Create extension models + workflows that use them
```

## Simple Shell Command Model

**Step 1: Create the model**

```bash
swamp model create command/shell my-shell --json
```

**Step 2: Configure the model input**

```yaml
# models/my-shell/input.yaml
name: my-shell
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: "echo 'Hello from ${{ self.name }}'"
```

**Step 3: Run and access output**

```bash
swamp model method run my-shell execute
```

**Output data path**: `model.my-shell.resource.result.result.attributes.stdout`

## Chained Lookup Models

### Pattern: VPC → Subnet → Instance

**Step 1: VPC Lookup**

```bash
swamp model create command/shell vpc-lookup --json
```

```yaml
# models/vpc-lookup/input.yaml
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

```bash
swamp model method run vpc-lookup execute
```

**Step 2: Subnet Lookup (references VPC)**

```bash
swamp model create command/shell subnet-lookup --json
```

```yaml
# models/subnet-lookup/input.yaml
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

**Step 3: Instance (references both)**

```bash
swamp model create @user/ec2-instance my-instance --json
```

```yaml
# models/my-instance/input.yaml
name: my-instance
version: 1
tags: {}
globalArguments:
  vpcId: ${{ model.vpc-lookup.resource.result.result.attributes.stdout }}
  subnetId: ${{ model.subnet-lookup.resource.result.result.attributes.stdout }}
  instanceType: t3.micro
  tags:
    Name: ${{ self.name }}
```

### Key CEL Paths Used

| Model         | Expression                                                     | Value             |
| ------------- | -------------------------------------------------------------- | ----------------- |
| vpc-lookup    | `model.vpc-lookup.resource.result.result.attributes.stdout`    | `vpc-12345678`    |
| subnet-lookup | `model.subnet-lookup.resource.result.result.attributes.stdout` | `subnet-abcd1234` |
| my-instance   | `self.name`                                                    | `my-instance`     |

## Model with Runtime Inputs

Models can accept runtime inputs via `--input` or `--input-file`:

**Step 1: Define model with inputs schema**

```yaml
# models/my-deploy/input.yaml
name: my-deploy
version: 1
tags: {}
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target environment
    dryRun:
      type: boolean
      default: false
  required: ["environment"]
globalArguments:
  target: ${{ inputs.environment }}
  simulate: ${{ inputs.dryRun }}
methods:
  deploy:
    arguments: {}
```

**Step 2: Run with inputs**

```bash
# Key-value inputs (preferred for simple values)
swamp model method run my-deploy deploy --input environment=production

# Multiple inputs
swamp model method run my-deploy deploy --input environment=production --input dryRun=true

# Dot notation for nested values
swamp model method run my-deploy deploy --input config.timeout=30

# JSON input (useful for complex structures)
swamp model method run my-deploy deploy --input '{"environment": "production"}'

# YAML file input
swamp model method run my-deploy deploy --input-file inputs.yaml
```

**Input file format (inputs.yaml)**:

```yaml
environment: production
dryRun: true
```

## Cross-Model Data References

### Preferred: data.latest() Expressions

Always use `data.latest()` for referencing other models' data. It reads directly
from disk on every call, so it always reflects the latest state:

```yaml
# CORRECT: data.latest() — always reads fresh data from disk
globalArguments:
  vpcId: ${{ data.latest("my-vpc", "main").attributes.VpcId }}

# DEPRECATED: model.*.resource — will be removed in a future release
globalArguments:
  vpcId: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
```

### Why data.latest() is Preferred

| Feature                   | `data.latest()` | `model.*.resource` |
| ------------------------- | --------------- | ------------------ |
| Always fresh (no cache)   | Yes (sync disk) | Yes (eager load)   |
| Supports vary dimensions  | Yes             | No                 |
| Clear dependency tracking | Yes             | Yes                |
| Future-proof              | Yes (canonical) | No (deprecated)    |

### Other data.* Functions

```yaml
# Specific version (rollback scenario)
previousConfig: ${{ data.version("app-config", "config", 1).attributes.setting }}

# Dynamic model name
dynamicValue: ${{ data.latest(inputs.modelName, "state").attributes.value }}

# Find all instances of a spec
allSubnets: ${{ data.findBySpec("scanner", "subnet") }}

# Find by tag
prodResources: ${{ data.findByTag("env", "prod") }}
```

### Self-References

Use `self.*` to reference the current model's properties:

```yaml
globalArguments:
  resourceName: ${{ self.name }}-resource
  version: ${{ self.version }}
  existingCidr: ${{ self.globalArguments.cidrBlock }}
```

### Environment Variables

```yaml
globalArguments:
  region: ${{ env.AWS_REGION }}
  profile: ${{ env.AWS_PROFILE }}
```

### Vault Secrets

```yaml
globalArguments:
  apiKey: ${{ vault.get("prod-vault", "API_KEY") }}
  dbPassword: ${{ vault.get("prod-vault", "DB_PASSWORD") }}
```
