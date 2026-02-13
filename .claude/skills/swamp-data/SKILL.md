---
name: swamp-data
description: Manage model data lifecycle and garbage collection. Use when listing data, viewing versions, cleaning up old data, or understanding data retention. Triggers on "data", "swamp data", "model data", "data list", "data get", "data versions", "garbage collection", "gc", "data gc", "clean up data", "old data", "data retention", "data lifecycle", "version history", "data cleanup", "prune data", "expire data", "ephemeral data".
---

# Swamp Data Skill

Manage model data lifecycle through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task                   | Command                                        |
| ---------------------- | ---------------------------------------------- |
| Search all data        | `swamp data search --json`                     |
| Search with filters    | `swamp data search --type resource --since 1d` |
| Search by workflow     | `swamp data search --workflow my-workflow`     |
| Search by model        | `swamp data search --model my-model`           |
| Free-text search       | `swamp data search vpc --json`                 |
| List model data        | `swamp data list <model> --json`               |
| List workflow data     | `swamp data list --workflow <name> --json`     |
| Get specific data      | `swamp data get <model> <name> --json`         |
| Get data via workflow  | `swamp data get --workflow <name> <data_name>` |
| View version history   | `swamp data versions <model> <name> --json`    |
| Run garbage collection | `swamp data gc --json`                         |
| Preview GC (dry run)   | `swamp data gc --dry-run --json`               |

## Data Concepts

### What is Model Data?

Models produce data when methods execute. Each data item has:

- **Name**: Unique identifier within the model
- **Version**: Auto-incrementing integer (starts at 1)
- **Lifetime**: How long data persists
- **Content type**: MIME type of the data
- **Tags**: Key-value pairs for categorization (e.g., `type=resource`)

### Data Tags

Standard tags categorize data:

| Tag               | Description                                     |
| ----------------- | ----------------------------------------------- |
| `type=resource`   | Structured JSON data (validated against schema) |
| `type=file`       | Binary/text file artifacts (including logs)     |
| `specName=<name>` | Output spec key name (for `data.findBySpec()`)  |

### Lifetime Types

Data lifetime controls automatic expiration:

| Lifetime    | Behavior                                              |
| ----------- | ----------------------------------------------------- |
| `ephemeral` | Deleted after method invocation or workflow completes |
| `job`       | Persists only while the creating job runs             |
| `workflow`  | Persists only while the creating workflow runs        |
| Duration    | Expires after time period (e.g., `1h`, `7d`, `1mo`)   |
| `infinite`  | Never expires (default for resources)                 |

### Version Garbage Collection

Each data item can have multiple versions. The GC setting controls version
retention:

| GC Setting  | Behavior                              |
| ----------- | ------------------------------------- |
| Integer (N) | Keep only the latest N versions       |
| Duration    | Keep versions newer than the duration |
| `infinite`  | Keep all versions forever             |

## Search Data

Search across all models with extensive filtering options.

```bash
# All data in the repo
swamp data search --json

# Filter by type tag
swamp data search --type resource --json

# Data from last hour
swamp data search --since 1h --json

# Workflow-produced data
swamp data search --workflow test-data-fetch --json

# Model-specific data
swamp data search --model my-processor --json

# By content type
swamp data search --content-type application/json --json

# By owner type
swamp data search --owner-type workflow-step --json

# Free-text search
swamp data search vpc --json

# Filter by arbitrary tag
swamp data search --tag env=prod --json

# Multiple tags (AND logic)
swamp data search --tag env=prod --tag team=platform --json

# Combined filters (AND logic)
swamp data search --type resource --since 1d --workflow deploy --json

# Tags with other filters
swamp data search --tag env=staging --type resource --since 1d --json

# Limit results
swamp data search --limit 10 --json
```

**Search filters:**

| Filter           | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `--type`         | Data type tag (log, file, resource, data)               |
| `--lifetime`     | Lifetime (ephemeral, infinite, job, workflow, duration) |
| `--owner-type`   | Owner type (model-method, workflow-step, manual)        |
| `--workflow`     | Workflow name tag                                       |
| `--model`        | Model name                                              |
| `--content-type` | MIME content type                                       |
| `--since`        | Duration (1h, 1d, 7d, 1w, 1mo)                          |
| `--output`       | Model output ID                                         |
| `--run`          | Workflow run ID                                         |
| `--tag`          | Arbitrary tag (KEY=VALUE, repeatable, AND logic)        |
| `--streaming`    | Only streaming data                                     |
| `--limit`        | Max results (default: 50)                               |

## List Model Data

View all data items for a model, grouped by tag type.

```bash
swamp data list my-model --json
```

**Output shape:**

```json
{
  "model": "my-model",
  "modelId": "abc-123",
  "data": {
    "log": [
      { "name": "execution-log", "versions": 5, "latestVersion": 5 }
    ],
    "resource": [
      { "name": "state", "versions": 3, "latestVersion": 3 }
    ],
    "data": [
      { "name": "output", "versions": 2, "latestVersion": 2 }
    ]
  }
}
```

## Get Specific Data

Retrieve the latest version of a specific data item.

```bash
swamp data get my-model execution-log --json
```

**Output shape:**

```json
{
  "model": "my-model",
  "name": "execution-log",
  "version": 5,
  "lifetime": "7d",
  "contentType": "text/plain",
  "tags": { "type": "resource" },
  "createdAt": "2025-01-15T10:30:00Z",
  "path": ".swamp/data/my-type/abc-123/execution-log/5/raw"
}
```

## Workflow-Scoped Data Access

List or get data produced by a workflow run instead of specifying a model.

```bash
# List all data from the latest run of a workflow
swamp data list --workflow test-data-fetch --json

# List data from a specific run
swamp data list --workflow test-data-fetch --run <run_id> --json

# Get specific data by name from a workflow run
swamp data get --workflow test-data-fetch output --json

# Get with specific version
swamp data get --workflow test-data-fetch output --version 2 --json
```

## View Version History

See all versions of a specific data item.

```bash
swamp data versions my-model state --json
```

**Output shape:**

```json
{
  "model": "my-model",
  "name": "state",
  "versions": [
    { "version": 3, "createdAt": "2025-01-15T10:30:00Z", "size": 1024 },
    { "version": 2, "createdAt": "2025-01-14T09:00:00Z", "size": 980 },
    { "version": 1, "createdAt": "2025-01-13T08:00:00Z", "size": 512 }
  ],
  "gcSetting": 5,
  "lifetime": "infinite"
}
```

## Garbage Collection

Clean up expired data and old versions based on lifecycle settings.

**Preview what would be deleted:**

```bash
swamp data gc --dry-run --json
```

**Output shape:**

```json
{
  "dryRun": true,
  "expired": [
    { "model": "temp-model", "name": "cache", "reason": "lifetime:ephemeral" },
    { "model": "old-model", "name": "log", "reason": "lifetime:1h" }
  ],
  "versions": [
    {
      "model": "my-model",
      "name": "state",
      "pruned": [1, 2],
      "kept": [3, 4, 5],
      "reason": "gc:3"
    }
  ],
  "summary": {
    "dataItemsToDelete": 2,
    "versionsToDelete": 2,
    "spaceToFree": "15.2 MB"
  }
}
```

**Run garbage collection:**

```bash
swamp data gc --json
swamp data gc -f --json  # Skip confirmation prompt
```

**Output shape:**

```json
{
  "dryRun": false,
  "deleted": {
    "dataItems": 2,
    "versions": 2,
    "spaceFreed": "15.2 MB"
  }
}
```

## Accessing Data in Expressions

Use CEL expressions to access model data in workflows and model inputs.

**Note:** `model.<name>.resource.<spec>` requires the model to have previously
produced data (a method was run that called `writeResource`). If no data exists
yet, accessing `.resource` will fail with "No such key". Use
`swamp data list <model-name>` to verify data exists.

```yaml
# Access latest resource data via dot notation
value: ${{ model.my-model.resource.output.main.attributes.result }}

# Access specific version
value: ${{ data.version("my-model", "main", 2).attributes.result }}

# Access file metadata
path: ${{ model.my-model.file.content.primary.path }}
size: ${{ model.my-model.file.content.primary.size }}

# Lazy-load file contents
body: ${{ file.contents("my-model", "content") }}
```

### Data Namespace Functions

| Function                                     | Description                               |
| -------------------------------------------- | ----------------------------------------- |
| `data.version(modelName, dataName, version)` | Get specific version of data              |
| `data.latest(modelName, dataName)`           | Get latest version of data                |
| `data.listVersions(modelName, dataName)`     | Get array of available version numbers    |
| `data.findByTag(tagKey, tagValue)`           | Find all data matching a tag              |
| `data.findBySpec(modelName, specName)`       | Find all data from a specific output spec |

**DataRecord structure** returned by these functions:

```json
{
  "id": "uuid",
  "name": "data-name",
  "version": 3,
  "createdAt": "2025-01-15T10:30:00Z",
  "attributes": {/* data content */},
  "tags": { "type": "resource" }
}
```

**Example usage:**

```yaml
# Get specific version
oldValue: ${{ data.version("my-model", "state", 2).attributes.value }}

# Get latest
current: ${{ data.latest("my-model", "output").attributes.result }}

# List versions for conditional logic
hasHistory: ${{ size(data.listVersions("my-model", "state")) > 1 }}

# Find all resources across models
allResources: ${{ data.findByTag("type", "resource") }}

# Find data from a specific workflow
workflowData: ${{ data.findByTag("workflow", "my-workflow") }}

# Find all instances from a factory model's output spec
subnets: ${{ data.findBySpec("my-scanner", "subnet") }}
```

**Key rules:**

- `model.<name>.resource.<specName>.<instanceName>` — accesses the latest
  version of a resource. Works both within a workflow run (in-memory updates)
  and across workflow runs (persisted data).
- `model.<name>.file.<specName>.<instanceName>` — accesses file metadata (path,
  size, contentType). Same behavior as resource expressions.
- `data.latest(modelName, dataName)` — reads persisted data snapshot taken at
  workflow start.
- Use `data.version()` function for specific versions
- Use `data.findByTag()` to query across models
- See the `swamp-workflow` skill's
  [data-chaining reference](../swamp-workflow/references/data-chaining.md) for
  detailed guidance on expression choice in workflows.

## Data Ownership

Data artifacts are owned by the model (definition) that created them. This
ensures data integrity and prevents accidental overwrites.

### Owner Definition

Each data item tracks its owner through the `ownerDefinition` field:

| Field            | Description                                  |
| ---------------- | -------------------------------------------- |
| `type`           | `model-method`, `workflow-step`, or `manual` |
| `ref`            | Reference to the creating entity             |
| `definitionHash` | Hash of the definition at creation time      |
| `workflowId`     | Set when created during workflow execution   |
| `workflowRunId`  | Specific run that created this data          |

### Ownership Validation

When a model method writes data:

1. **New data**: Created with current model as owner
2. **Existing data**: Validates `ownerDefinition.definitionHash` matches
3. **Hash mismatch**: Write fails with ownership error

This prevents scenarios where multiple models accidentally share data names.

### Viewing Ownership

Use `swamp data get` to see ownership information:

```bash
swamp data get my-model state --json
```

```json
{
  "name": "state",
  "version": 3,
  "ownerDefinition": {
    "type": "model-method",
    "ref": "my-model:create",
    "definitionHash": "abc123..."
  }
}
```

## Data Storage

Data is stored in the `.swamp/data/` directory:

```
.swamp/data/{normalized-type}/{model-id}/{data-name}/
  1/
    raw          # Actual data content
    metadata.yaml # Version metadata
  2/
    raw
    metadata.yaml
  latest → 2/    # Symlink to latest version
```

## When to Use Other Skills

| Need                 | Use Skill                       |
| -------------------- | ------------------------------- |
| Create/run models    | `swamp-model`                   |
| View model outputs   | `swamp-model` (output commands) |
| Create/run workflows | `swamp-workflow`                |
| Repository structure | `swamp-repo`                    |
| Manage secrets       | `swamp-vault`                   |

## References

- **Examples**: See [references/examples.md](references/examples.md) for data
  query patterns, CEL expressions, and GC scenarios
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Data design**: See [design/models.md](design/models.md) for data lifecycle
  details
- **Expressions**: See [design/expressions.md](design/expressions.md) for CEL
  syntax
