# Behavior Examples and CEL Reference

## Table of Contents

- [CEL Expression Quick Reference](#cel-expression-quick-reference)
- [Decision Tree: What to Build](#decision-tree-what-to-build)
- [Simple Shell Command Behavior](#simple-shell-command-behavior)
- [Chained Lookup Behaviors](#chained-lookup-behaviors)
- [Behavior with Runtime Inputs](#behavior-with-runtime-inputs)
- [Cross-Behavior Data References](#cross-behavior-data-references)

## CEL Expression Quick Reference

| Expression Pattern                                           | Description                                  | Example Value                 |
| ------------------------------------------------------------ | -------------------------------------------- | ----------------------------- |
| `data.latest("<model>", "<name>").attributes.<field>`        | Latest data (sees current-run writes)        | VPC ID, subnet CIDR, etc.     |
| `data.latest("<model>", "<name>").?attributes.?<field>`      | Null-safe — returns null if missing          | Prior cycle findings          |
| `data.version("<model>", "<name>", N).attributes.<field>`    | Specific version of data                     | Rollback to version 1         |
| `data.findBySpec("<model>", "<spec>")`                       | Find all instances from a spec               | All subnets from scanner      |
| `data.findByTag("<key>", "<value>")`                         | Find data by tag                             | All resources tagged env=prod |
| `model.<name>.resource.<spec>.<instance>.attributes.<field>` | Cross-behavior resource (DEPRECATED)         | VPC ID, subnet CIDR, etc.     |
| `model.<name>.resource.result.result.attributes.stdout`      | command/shell stdout (DEPRECATED)            | AMI ID from aws cli command   |
| `data.latest("<model>", "<name>").path`                      | Local path of another behavior's stored file | `/path/to/file.txt`           |
| `model.<name>.file.<spec>.<instance>.path`                   | File path from another behavior (DEPRECATED) | `/path/to/file.txt`           |
| `self.name`                                                  | Current behavior's name                      | `my-vpc`                      |
| `self.version`                                               | Current behavior's version                   | `1`                           |
| `self.globalArguments.<field>`                               | This behavior's own global argument          | CIDR block, region, etc.      |
| `inputs.<name>`                                              | Runtime input value                          | `production`, `true`, etc.    |
| `env.<VAR_NAME>`                                             | Environment variable                         | AWS region, credentials       |
| `vault.get("<vault>", "<key>")`                              | Vault secret (literal args)                  | API key, password             |
| `vault.get(inputs.vault, inputs.key)`                        | Vault secret (dynamic CEL args)              | Per-target secret             |

### CEL Path Patterns by Behavior Type

| Behavior Type    | Resource Spec | Instance    | CEL Path Example                                              |
| ---------------- | ------------- | ----------- | ------------------------------------------------------------- |
| `command/shell`  | `result`      | `result`    | `model.my-shell.resource.result.result.attributes.stdout`     |
| `@user/vpc`      | `vpc`         | `main`      | `model.my-vpc.resource.vpc.main.attributes.VpcId`             |
| `@user/subnet`   | `subnet`      | `primary`   | `model.my-subnet.resource.subnet.primary.attributes.SubnetId` |
| Factory behavior | `<spec>`      | `<dynamic>` | `model.scanner.resource.subnet.subnet-aaa.attributes.cidr`    |

## Decision Tree: What to Build

```
What does the user want to accomplish?
│
├── Run a single command or API call
│   └── Create a behavior (command/shell or @user/custom)
│
├── Orchestrate multiple steps in order
│   └── Create a swamp workflow with jobs and steps
│
├── Need custom capabilities not in existing types
│   └── Create an extension model (@user/my-type) in extensions/models/
│
└── Combine all of the above
    └── Create extension behaviors + workflows that use them
```

## Simple Shell Command Behavior

**Step 1: Create the behavior**

```bash
swamp behavior create command/shell my-shell --json
```

**Step 2: Configure the behavior input**

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
swamp behavior run my-shell execute
```

**Output data path**: `model.my-shell.resource.result.result.attributes.stdout`

## Chained Lookup Behaviors

### Pattern: VPC → Subnet → Instance

**Step 1: VPC Lookup**

```bash
swamp behavior create command/shell vpc-lookup --json
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
swamp behavior run vpc-lookup execute
```

**Step 2: Subnet Lookup (references VPC)**

```bash
swamp behavior create command/shell subnet-lookup --json
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
swamp behavior create @user/ec2-instance my-instance --json
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

| Behavior      | Expression                                                     | Value             |
| ------------- | -------------------------------------------------------------- | ----------------- |
| vpc-lookup    | `model.vpc-lookup.resource.result.result.attributes.stdout`    | `vpc-12345678`    |
| subnet-lookup | `model.subnet-lookup.resource.result.result.attributes.stdout` | `subnet-abcd1234` |
| my-instance   | `self.name`                                                    | `my-instance`     |

## Behavior with Runtime Inputs

Behaviors can accept runtime inputs via `--input` or `--input-file`:

**Step 1: Define behavior with inputs schema**

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
swamp behavior run my-deploy deploy --input environment=production

# Multiple inputs
swamp behavior run my-deploy deploy --input environment=production --input dryRun=true

# Dot notation for nested values
swamp behavior run my-deploy deploy --input config.timeout=30

# JSON input (useful for complex structures)
swamp behavior run my-deploy deploy --input '{"environment": "production"}'

# YAML file input
swamp behavior run my-deploy deploy --input-file inputs.yaml

# Piped stdin (explicit --stdin flag required)
echo '{"environment": "production"}' | swamp behavior run my-deploy deploy --stdin

# NDJSON from stdin: one run per line
printf '{"environment":"dev"}\n{"environment":"prod"}' | swamp behavior run my-deploy deploy --stdin

# Pipe from data query via jq
swamp data query 'modelName == "source"' --json \
  | jq -c '.results[] | {environment: .attributes.env}' \
  | swamp behavior run my-deploy deploy --stdin

# Stdin + --input overrides (--input wins on conflict)
echo '{"environment": "dev"}' | swamp behavior run my-deploy deploy --stdin --input dryRun=true
```

**Input file format (inputs.yaml)**:

```yaml
environment: production
dryRun: true
```

## Cross-Behavior Data References

### Use the `data.*` namespace

Use `data.*` expressions to reference other behaviors' data. `data.query()` is
the underlying primitive; the shortcut helpers read more clearly when your
intent matches, so prefer a shortcut if it fits and reach for `data.query()`
when you need a multi-field predicate or a projection.

```yaml
# Shortcut — reads most clearly for a single-behavior-and-name lookup
globalArguments:
  vpcId: ${{ data.latest("my-vpc", "main").attributes.VpcId }}

# DEPRECATED: model.*.resource — will be removed in a future release
globalArguments:
  vpcId: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
```

### Why `data.*` vs `model.*.resource`

| Feature                   | `data.*` namespace | `model.*.resource` |
| ------------------------- | ------------------ | ------------------ |
| Always fresh (no cache)   | Yes (sync disk)    | Yes (eager load)   |
| Supports vary dimensions  | Yes                | No                 |
| Clear dependency tracking | Yes                | Yes                |
| Future-proof              | Yes                | No (deprecated)    |

### data.* functions

```yaml
# Specific version (rollback scenario)
previousConfig: ${{ data.version("app-config", "config", 1).attributes.setting }}

# Dynamic behavior name
dynamicValue: ${{ data.latest(inputs.modelName, "state").attributes.value }}

# Find all instances of a spec
allSubnets: ${{ data.findBySpec("scanner", "subnet") }}

# Find by tag
prodResources: ${{ data.findByTag("env", "prod") }}

# Multi-field predicate — reach for data.query() when no shortcut fits
prodFailures: ${{ data.query('modelName == "scanner" && tags.env == "prod" && attributes.status == "failed"') }}
```

See the `swamp-data` skill's references/expressions.md for the full shortcut
mapping table.

### Self-References

Use `self.*` to reference the current behavior's properties:

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
