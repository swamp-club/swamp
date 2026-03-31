# Data Query and Expression Examples

## Table of Contents

- [CEL Expression Quick Reference](#cel-expression-quick-reference)
- [CEL Path Patterns by Model Type](#cel-path-patterns-by-model-type)
- [Cross-Model Data References](#cross-model-data-references)
- [Data Discovery Patterns](#data-discovery-patterns)
- [Version Management](#version-management)
- [Rename Scenarios](#rename-scenarios)
- [Garbage Collection Scenarios](#garbage-collection-scenarios)
- [Workflow Data Access](#workflow-data-access)

## CEL Expression Quick Reference

| Expression Pattern                                           | Description                                 |
| ------------------------------------------------------------ | ------------------------------------------- |
| `model.<name>.resource.<spec>.<instance>.attributes.<field>` | Cross-model resource reference (PREFERRED)  |
| `model.<name>.resource.result.result.attributes.stdout`      | command/shell stdout                        |
| `model.<name>.file.<spec>.<instance>.path`                   | File path reference                         |
| `self.name`                                                  | Current model's name                        |
| `inputs.<name>`                                              | Workflow or model runtime input             |
| `env.<VAR_NAME>`                                             | Environment variable                        |
| `vault.get("<vault-name>", "<key>")`                         | Vault secret                                |
| `data.version("<model>", "<name>", <version>)`               | Specific version of data                    |
| `data.latest("<model>", "<name>")`                           | Latest version (snapshot at workflow start) |
| `data.findByTag("<key>", "<value>")`                         | Find data by tag                            |
| `data.findBySpec("<model>", "<spec>")`                       | Find all instances from a spec              |

## CEL Path Patterns by Model Type

| Model Type      | CEL Path                                                             | Notes                              |
| --------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `command/shell` | `model.<name>.resource.result.result.attributes.stdout`              | Built-in uses `result` for both    |
| `@user/custom`  | `model.<name>.resource.<spec>.<instance>.attributes.<field>`         | You choose both names              |
| Factory models  | `model.<name>.resource.<spec>.<dynamic-instance>.attributes.<field>` | Instance varies (e.g., `vpc-1234`) |

## Cross-Model Data References

### Preferred: model.* Expressions

Always prefer `model.*` expressions over `data.latest()` for referencing other
models' data. The `model.*` expression provides:

- In-memory updates during workflow execution
- Type-safe attribute access
- Clear dependency tracking

```yaml
# PREFERRED: Cross-model resource reference
globalArguments:
  vpcId: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
  subnetId: ${{ model.public-subnet.resource.subnet.primary.attributes.SubnetId }}

# For command/shell models
globalArguments:
  imageId: ${{ model.ami-lookup.resource.result.result.attributes.stdout }}
```

### When to Use data.latest()

Use `data.latest()` only when you need:

- A snapshot from workflow start (not live updates)
- Dynamic model name lookup

```yaml
# Snapshot at workflow start
oldValue: ${{ data.latest("my-model", "state").attributes.value }}

# Rollback scenario — get previous version
previousConfig: ${{ data.version("my-model", "config", 1).attributes.setting }}
```

## Data Discovery Patterns

### Find All Resources by Tag

```yaml
# Find all data with type=resource tag
allResources: ${{ data.findByTag("type", "resource") }}

# Find all data from a specific workflow
workflowData: ${{ data.findByTag("workflow", "deploy-workflow") }}

# Find all data with custom tag
prodResources: ${{ data.findByTag("env", "production") }}
```

### Find Factory Model Instances

Factory models produce multiple instances from a single output spec. Use
`data.findBySpec()` to discover all instances:

```yaml
# Get all subnets discovered by a scanner model
subnets: ${{ data.findBySpec("subnet-scanner", "subnet") }}

# Iterate over discovered instances in forEach
jobs:
  - name: process-subnets
    steps:
      - name: tag-subnet-${{ self.subnetId }}
        forEach:
          item: subnet
          in: ${{ data.findBySpec("subnet-scanner", "subnet") }}
        task:
          type: model_method
          modelIdOrName: subnet-tagger
          methodName: tag
          inputs:
            subnetId: ${{ self.subnet.attributes.subnetId }}
```

### Access Specific Named Instance

```yaml
# Known instance name from factory model
subnetA: ${{ model.subnet-scanner.resource.subnet.subnet-aaa.attributes.cidr }}

# Single-instance model — use descriptive instance name
vpcId: ${{ model.my-vpc.resource.vpc.main.attributes.VpcId }}
```

## Version Management

### Get Specific Version

```yaml
# Get version 2 of a model's data
previousState: ${{ data.version("my-model", "state", 2).attributes.value }}

# Use in rollback workflow
jobs:
  - name: rollback
    steps:
      - name: restore-config
        task:
          type: model_method
          modelIdOrName: config-restore
          methodName: restore
          inputs:
            config: ${{ data.version("app-config", "config", 1).attributes }}
```

### Check Version History

```bash
# List all versions
swamp data versions my-model state --json

# Check if multiple versions exist
hasHistory: ${{ size(data.listVersions("my-model", "state")) > 1 }}
```

### Version-Aware Conditional Logic

```yaml
# Only rollback if we have a previous version
jobs:
  - name: maybe-rollback
    steps:
      - name: check-versions
        condition: ${{ size(data.listVersions("app-config", "config")) > 1 }}
        task:
          type: model_method
          modelIdOrName: app-config
          methodName: rollback
```

## Rename Scenarios

### Basic Rename

```bash
# Rename a data instance
swamp data rename my-vpc web-vpc dev-web-vpc

# Output:
# Renamed "web-vpc" -> "dev-web-vpc" for my-vpc (aws/vpc)
# Version 3 copied as v1 under new name
# Old name "web-vpc" now forwards to "dev-web-vpc"
# WARNING: Any workflows or models that produce data under "web-vpc"
#          will overwrite the forward reference. Update them to use
#          "dev-web-vpc" instead.
```

### Verify Forward Reference Works

```bash
# Old name transparently resolves to new name
swamp data get my-vpc web-vpc --json
# Returns the data under "dev-web-vpc"

# Historical versions still accessible
swamp data versions my-vpc web-vpc --json
# Shows old versions before the rename
```

### After Rename: Update References

After renaming, update workflows and model inputs to use the new name:

```yaml
# Before rename
globalArguments:
  vpcId: ${{ model.my-vpc.resource.vpc.web-vpc.attributes.VpcId }}

# After rename — update to new name
globalArguments:
  vpcId: ${{ model.my-vpc.resource.vpc.dev-web-vpc.attributes.VpcId }}
```

The old expression still works via forward reference, but updating is
recommended to avoid surprises if the model re-runs and overwrites the forward
reference.

## Garbage Collection Scenarios

### Preview GC Impact

```bash
# Always preview before running GC
swamp data gc --dry-run --json
```

**Output shows:**

- `expiredDataCount` — count of expired data items
- `expiredData` — data items past their lifetime (with type, modelId, dataName,
  reason)

### Configure Version Retention

In your model's resource spec:

```typescript
resources: {
  "state": {
    description: "Application state",
    schema: StateSchema,
    lifetime: "infinite",    // Never expire
    garbageCollection: 10,   // Keep last 10 versions
  },
  "log": {
    description: "Execution log",
    schema: LogSchema,
    lifetime: "7d",          // Expire after 7 days
    garbageCollection: 5,    // Keep last 5 versions
  },
},
```

### GC Policy Reference

| Lifetime    | GC Setting | Behavior                                      |
| ----------- | ---------- | --------------------------------------------- |
| `infinite`  | 10         | Keep forever, but only last 10 versions       |
| `7d`        | 5          | Delete after 7 days, keep last 5 versions     |
| `ephemeral` | 1          | Delete after method completes, keep 1 version |
| `workflow`  | 3          | Delete when workflow ends, keep 3 versions    |

### Run GC After Cleanup Workflows

```yaml
# After running a delete workflow, clean up orphaned data
jobs:
  - name: cleanup
    steps:
      - name: delete-resources
        task:
          type: workflow
          workflowIdOrName: delete-all-resources
      - name: run-gc
        task:
          type: model_method
          modelIdOrName: gc-runner
          methodName: gc
```

## Workflow Data Access

### Access Data from Latest Workflow Run

```bash
# List data from the latest run of a workflow
swamp data list --workflow deploy-workflow --json

# Get specific data artifact
swamp data get --workflow deploy-workflow deployment-state --json
```

### Cross-Workflow Data References

Parent workflow creates resources, sub-workflow uses them:

```yaml
# Parent workflow (create-networking)
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

```yaml
# Model used by sub-workflow (tag-networking)
name: tag-vpc
globalArguments:
  resourceId: ${{ model.networking-vpc.resource.vpc.main.attributes.VpcId }}
  tagKey: ManagedBy
  tagValue: Swamp
```

### Query Workflow-Produced Data

Use `swamp data query` with CEL predicates (see `swamp-data-query` skill):

```bash
# Find all data created by a specific workflow
swamp data query 'tags.workflow == "deploy-workflow"'

# Filter by type within workflow data
swamp data query 'tags.workflow == "deploy-workflow" && dataType == "resource"'

# With projection — extract specific fields
swamp data query 'tags.workflow == "deploy-workflow"' --select '{"name": name, "spec": specName}'
```
