---
name: swamp-data
description: Manage model data lifecycle and garbage collection. Use when listing data, viewing versions, cleaning up old data, or understanding data retention. Triggers on "data", "swamp data", "model data", "data list", "data get", "data versions", "garbage collection", "gc", "data gc", "clean up data", "old data", "data retention", "data lifecycle", "version history", "data cleanup", "prune data", "expire data", "ephemeral data".
---

# Swamp Data Skill

Manage model data lifecycle through the CLI. All commands support `--json` for
machine-readable output.

## Quick Reference

| Task                   | Command                                     |
| ---------------------- | ------------------------------------------- |
| List model data        | `swamp data list <model> --json`            |
| Get specific data      | `swamp data get <model> <name> --json`      |
| View version history   | `swamp data versions <model> <name> --json` |
| Run garbage collection | `swamp data gc --json`                      |
| Preview GC (dry run)   | `swamp data gc --dry-run --json`            |

## Data Concepts

### What is Model Data?

Models produce data when methods execute. Each data item has:

- **Name**: Unique identifier within the model
- **Version**: Auto-incrementing integer (starts at 1)
- **Lifetime**: How long data persists
- **Content type**: MIME type of the data
- **Tags**: Key-value pairs for categorization (e.g., `type=log`)

### Data Tags

Standard tags categorize data:

| Tag             | Description                      |
| --------------- | -------------------------------- |
| `type=log`      | Execution logs (streaming, text) |
| `type=file`     | File artifacts                   |
| `type=resource` | External resource state          |
| `type=data`     | General model data               |

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
  "tags": { "type": "log" },
  "createdAt": "2025-01-15T10:30:00Z",
  "path": ".swamp/data/my-type/abc-123/execution-log/5/raw"
}
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

Use CEL expressions to access model data in workflows and model inputs:

```yaml
# Access latest version (implied)
value: ${{ model.my-model.data.attributes.result }}

# Access specific version
value: ${{ data.version(my-model, output, 2).attributes.result }}
```

**Key rules:**

- `model.<name>.data` always refers to the latest version
- Use `data.version()` function for specific versions
- Data expressions create implicit step dependencies in workflows

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

- **Data design**: See [design/models.md](design/models.md) for data lifecycle
  details
- **Expressions**: See [design/expressions.md](design/expressions.md) for CEL
  syntax
