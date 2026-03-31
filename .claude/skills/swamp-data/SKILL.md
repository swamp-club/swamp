---
name: swamp-data
description: Manage swamp model data — list data artifacts, view version history, delete expired versions, and run garbage collection. Use when working with swamp model data lifecycle, retention policies, or version cleanup. Triggers on "swamp data", "model data", "data list", "data get", "data versions", "garbage collection", "gc", "data gc", "data retention", "data lifecycle", "version history", "data cleanup", "prune data", "expire data", "ephemeral data".
---

# Swamp Data Skill

Manage model data lifecycle through the CLI. All commands support `--json` for
machine-readable output.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help data` for the complete, up-to-date CLI schema.

## Quick Reference

| Task                   | Command                                               |
| ---------------------- | ----------------------------------------------------- |
| Query by model         | `swamp data query 'modelName == "my-model"'`          |
| Query by type          | `swamp data query 'dataType == "resource"'`           |
| Query with projection  | `swamp data query 'modelName == "x"' --select 'name'` |
| Query by tags          | `swamp data query 'tags.env == "prod"'`               |
| Query by content       | `swamp data query 'attributes.status == "failed"'`    |
| List model data        | `swamp data list <model> --json`                      |
| List workflow data     | `swamp data list --workflow <name> --json`            |
| Get specific data      | `swamp data get <model> <name> --json`                |
| Get metadata only      | `swamp data get <model> <name> --no-content --json`   |
| Get data via workflow  | `swamp data get --workflow <name> <data_name> --json` |
| View version history   | `swamp data versions <model> <name> --json`           |
| Run garbage collection | `swamp data gc --json`                                |
| Rename data instance   | `swamp data rename <model> <old> <new>`               |
| Preview GC (dry run)   | `swamp data gc --dry-run --json`                      |

See [references/concepts.md](references/concepts.md) for lifetime types, tags,
and version GC policies.

## Query Data

Use `swamp data query` with CEL predicates for filtering and `--select` for
projection. See the `swamp-data-query` skill for full query syntax, filterable
fields, and projection examples.

```bash
# By model
swamp data query 'modelName == "my-model"'

# By type and tags
swamp data query 'dataType == "resource" && tags.env == "prod"'

# With projection — extract specific fields
swamp data query 'modelName == "scanner"' --select '{"name": name, "os": attributes.os}'

# By content
swamp data query 'attributes.status == "failed"' --select 'name'
```

## List Model Data

View all data items for a model, grouped by tag type.

```bash
swamp data list my-model --json
```

**Output shape:** Returns `modelId`, `modelName`, `modelType`, `groups` (items
grouped by type tag, each with `id`, `name`, `version`, `size`, `createdAt`),
and `total`. See
[references/output-shapes.md](references/output-shapes.md#list-data) for the
full output shape.

## Get Specific Data

Retrieve the latest version of a specific data item.

```bash
swamp data get my-model execution-log --json

# Metadata only (no content)
swamp data get my-model execution-log --no-content --json
```

**Output shape:** Returns `id`, `name`, `modelId`, `version`, `contentType`,
`lifetime`, `tags`, `ownerDefinition`, `size`, `checksum`, and `content`. See
[references/output-shapes.md](references/output-shapes.md#get-data) for the full
output shape.

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

**Output shape:** Returns `dataName`, `modelId`, `modelName`, `versions` (each
with `version`, `createdAt`, `size`, `checksum`, `isLatest`), and `total`. See
[references/output-shapes.md](references/output-shapes.md#versions) for the full
output shape.

## Rename Data

Data instance names are permanent once created — deleting and recreating under a
new name loses version history and breaks any workflows or expressions that
reference the old name. Use `data rename` to non-destructively rename with
backwards-compatible forwarding. The old name becomes a forward reference that
transparently resolves to the new name.

**When to rename:**

- Refactoring naming conventions (e.g., `web-vpc` → `dev-web-vpc`)
- Reorganizing data after a model's purpose evolves
- Fixing typos in data names without losing history

**Rename workflow:**

1. **Verify** the new name doesn't already exist:
   ```bash
   swamp data get my-model new-name --no-content --json
   ```
   This should return an error (not found). If it succeeds, the name is taken.
2. **Rename** the data instance:
   ```bash
   swamp data rename my-model old-name new-name
   ```
3. **Confirm** the forward reference works:
   ```bash
   swamp data get my-model old-name --no-content --json
   ```
   Should resolve to `new-name` via the forward reference.

**What happens:**

1. Latest version of `old-name` is copied to `new-name` (version 1)
2. A tombstone is written on `old-name` with a `renamedTo` forward reference
3. Future lookups of `old-name` transparently resolve to `new-name`
4. Historical versions of `old-name` remain accessible via
   `data.version("model", "old-name", N)`

**Forward reference behavior:**

- `data.latest("model", "old-name")` → resolves to `new-name` automatically
- `data.version("model", "old-name", 2)` → returns original version 2 (no
  forwarding)
- `model.<name>.resource.<spec>.<old-name>` → resolves to new name in
  expressions

**Important:** After renaming, update any workflows or models that produce data
under the old name. If a model re-runs and writes to the old name, it will
overwrite the forward reference.

## Garbage Collection

Clean up expired data and old versions based on lifecycle settings.

**IMPORTANT: Always dry-run first.** GC deletes data permanently. Follow this
workflow:

1. **Preview** what will be deleted:
   ```bash
   swamp data gc --dry-run --json
   ```
2. **Review** the output — verify only expected items appear
3. **Run** the actual GC only after confirming the dry-run output:
   ```bash
   swamp data gc --json
   swamp data gc -f --json  # Skip confirmation prompt
   ```

**Dry-run output shape:** Returns `expiredDataCount` and `expiredData` (each
with `type`, `modelId`, `dataName`, `reason`). See
[references/output-shapes.md](references/output-shapes.md#gc-dry-run) for the
full output shape.

**GC output shape:** Returns `dataEntriesExpired`, `versionsDeleted`,
`bytesReclaimed`, and `expiredEntries`. See
[references/output-shapes.md](references/output-shapes.md#gc-run) for the full
output shape.

## Accessing Data in Expressions

CEL expressions access model data in workflows and model inputs. Functions,
examples, and key rules are in
[references/expressions.md](references/expressions.md).

## Data Ownership

Data is owned by the creating model — see
[references/data-ownership.md](references/data-ownership.md) for owner fields,
validation rules, and viewing ownership.

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

| Need                       | Use Skill                       |
| -------------------------- | ------------------------------- |
| Create/run models          | `swamp-model`                   |
| View model outputs         | `swamp-model` (output commands) |
| Create/run workflows       | `swamp-workflow`                |
| Repository structure       | `swamp-repo`                    |
| Manage secrets             | `swamp-vault`                   |
| Understand swamp internals | `swamp-troubleshooting`         |

## References

- **Output shapes**: See
  [references/output-shapes.md](references/output-shapes.md) for JSON output
  examples from all data commands
- **Examples**: See [references/examples.md](references/examples.md) for data
  query patterns, CEL expressions, and GC scenarios
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Data design**: See [design/models.md](design/models.md) for data lifecycle
  details
- **Expressions**: See [design/expressions.md](design/expressions.md) for CEL
  syntax
