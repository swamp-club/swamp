---
name: swamp-data
description: >
  Manage swamp model data — list data artifacts, view version history, delete
  data artifacts, run garbage collection, and query data using CEL predicates.
  Use when working with swamp model data lifecycle, retention policies, version
  cleanup, removing specific data artifacts, searching for data by field values,
  filtering by attributes or tags, or exploring results after running a model
  method. Triggers on "swamp data", "model data", "data list", "data get",
  "data versions", "garbage collection", "gc", "data gc", "data retention",
  "data lifecycle", "version history", "data cleanup", "data delete", "delete
  data artifact", "remove data", "purge data", "prune data", "expire data",
  "ephemeral data", "data query", "query data", "find data", "search data
  where", "filter data", "which data has", "data with", "select from data",
  "data.query", "context.queryData", "CEL predicate", "data predicate",
  "inspect results", "method output", "factory results", "browse artifacts",
  "what did method produce".
---

# Swamp Data Skill

Manage model data lifecycle through the CLI. All commands support `--json` for
machine-readable output.

**Verify CLI syntax:** If unsure about exact flags or subcommands, run
`swamp help data` for the complete, up-to-date CLI schema.

## Query is the primitive; get/list/search/versions are shortcuts

`swamp data query` is the general data-access command — it takes any CEL
predicate over artifact metadata and content, with optional projections via
`--select`. The `get`, `list`, `search`, and `versions` subcommands are
shortcuts for common queries. **Prefer the shortcut when your intent matches** —
`swamp data get my-model state` reads more clearly than the equivalent
predicate. Reach for `swamp data query` directly when you need a multi-field
predicate, a projection, or history beyond a single version.

### CLI shortcut mapping

| Shortcut                              | Underlying query                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `swamp data get <m> <n>`              | `swamp data query 'modelName == "<m>" && name == "<n>"' --select content`                   |
| `swamp data get <m> <n> --version 2`  | `swamp data query 'modelName == "<m>" && name == "<n>" && version == 2' --select content`   |
| `swamp data list <m>`                 | `swamp data query 'modelName == "<m>"'`                                                     |
| `swamp data list <m> --type resource` | `swamp data query 'modelName == "<m>" && dataType == "resource"'`                           |
| `swamp data list --workflow <w>`      | `swamp data query 'workflowName == "<w>"'`                                                  |
| `swamp data list --run <id>`          | `swamp data query 'workflowRunId == "<id>"'`                                                |
| `swamp data versions <m> <n>`         | `swamp data query 'modelName == "<m>" && name == "<n>" && version >= 0' --select 'version'` |
| `swamp data search --tag env=prod`    | `swamp data query 'tags.env == "prod"'`                                                     |

The shortcut and the equivalent query run through the same catalog and return
the same `DataRecord` shape. See [references/fields.md](references/fields.md)
for the full list of queryable fields and predicate operators.

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
| Delete data artifact   | `swamp data delete <model> <name> --force`            |
| Delete one version     | `swamp data delete <model> <name> --version 3`        |
| Preview GC (dry run)   | `swamp data gc --dry-run --json`                      |

See [references/concepts.md](references/concepts.md) for lifetime types, tags,
and version GC policies.

## Query Data

Use `swamp data query` with CEL predicates for filtering and `--select` for
projection. See [references/fields.md](references/fields.md) for all filterable
fields and CEL operators.

```bash
# By model
swamp data query 'modelName == "my-model"'

# By type and tags
swamp data query 'dataType == "resource" && tags.env == "prod"'

# With projection — extract specific fields
swamp data query 'modelName == "scanner"' --select '{"name": name, "os": attributes.os}'

# By content
swamp data query 'attributes.status == "failed"' --select 'name'

# History — all versions of a specific data item
swamp data query 'modelName == "my-model" && name == "state" && version >= 0' --select 'version'

# Interactive mode — TUI with live autocomplete, no predicate needed
swamp data query
```

## List Model Data

View all data items for a model, grouped by tag type. Shortcut for
`swamp data query 'modelName == "<model>"'`.

```bash
swamp data list my-model --json
```

**Output shape:** Returns `modelId`, `modelName`, `modelType`, `groups` (items
grouped by type tag, each with `id`, `name`, `version`, `size`, `createdAt`),
and `total`. See
[references/output-shapes.md](references/output-shapes.md#list-data) for the
full output shape.

## Get Specific Data

Retrieve the latest version of a specific data item. Shortcut for
`swamp data query 'modelName == "<model>" && name == "<name>"' --select content`
(omit `--select content` to return metadata only).

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

See all versions of a specific data item. Shortcut for
`swamp data query 'modelName == "<model>" && name == "<name>" && version >= 0'`.

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

## Delete Data

Permanently remove a data artifact from a model. The artifact identity is the
`(model, name)` pair — `swamp data delete` operates on that pair, not on
individual versions, unless `--version` is given.

**When to delete:**

- Re-running an `import` or `start` method that's blocked by an existing-state
  guard (e.g., `[NP-E028]`) when you want a clean re-import
- Removing data that was created in error
- Cleaning up after a destructive change to an external resource

**Default semantics:**

- `swamp data delete <model> <name>` — deletes **all versions** of the artifact.
  Prompts `[y/N]` with the exact version count before proceeding.
- `swamp data delete <model> <name> --version 3` — deletes only that single
  version. The artifact's other versions remain.
- `swamp data delete <model> <name> --force` — skips the confirmation prompt.
  Required in scripts, JSON mode, and any non-interactive context.

**Errors are loud, not silent:**

- Missing model → `Model not found: <ref>`
- Missing artifact → `No data named "<name>" exists for model <model>`
- Missing version →
  `Version <V> does not exist for "<name>" (available
  versions: 1, 2, 3)`

```bash
# Full-artifact delete with confirmation prompt
swamp data delete my-server hetzner-state

# Surgical single-version delete
swamp data delete my-server hetzner-state --version 2

# Non-interactive (scripts, automation)
swamp data delete my-server hetzner-state --force --json
```

**Note on rename forwarders:** If `oldName → newName` was renamed, deleting
`newName` leaves the tombstone on `oldName` forwarding to nothing. Lookups via
the forwarded path will return null. Delete the tombstone explicitly with
`swamp data delete <model> oldName` if you want a clean slate.

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

- **Query fields**: See [references/fields.md](references/fields.md) for the
  complete list of filterable fields, CEL operators, and predicate examples
- **Output shapes**: See
  [references/output-shapes.md](references/output-shapes.md) for JSON output
  examples from all data commands
- **Examples**: See [references/examples.md](references/examples.md) for data
  query patterns, CEL expressions, and GC scenarios
- **Expressions**: See [references/expressions.md](references/expressions.md)
  for CEL expression patterns and the `data.*` namespace shortcut mapping
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
