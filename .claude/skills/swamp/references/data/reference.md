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

Read one data item with `swamp data query`. `swamp data get` is deprecated: it
still works, but every read warns and prints the equivalent query as
`replacementQuery`.

```bash
# Latest content
swamp data query 'modelName == "my-model" && name == "execution-log"' --select content

# A specific version (naming `version` also searches history)
swamp data query 'modelName == "my-model" && name == "execution-log" && version == 2' --select content

# One field of JSON content
swamp data query 'modelName == "my-model" && name == "state"' --select 'content.status'

# Metadata only (no content): omit --select
swamp data query 'modelName == "my-model" && name == "execution-log"' --json
```

**Output shape:** `--json` returns
`{"results": [...], "total": N, "limited":
bool}`. With `--select content` each
result is the content (JSON content is the parsed object), so read `results[0]`;
without `--select` each result is the item's metadata record. An empty `results`
array means no such item. The query matches the instance `name` exactly; to
match a spec name use `specName == "<spec>"`.

**Binary content:** When the stored bytes are valid UTF-8, `contentEncoding` is
`"utf-8"` and `content` is the text (a leading byte-order mark is dropped), or
the parsed value for `application/json` content that parses. Otherwise (an
image, an archive) `contentEncoding` is `"base64"` and `content` is the
base64-encoded bytes, so no byte is lost. Without `--json`, binary data prints a
one-line notice instead of the bytes. `data query` returns `content` only for
text content types (`text/*`, JSON, YAML), so saving a binary artifact still
goes through the deprecated `data get`:

```bash
swamp data get my-model logo --json | jq -r .content | base64 -d > logo.png
```

## Workflow-Scoped Data Access

List or read data produced by a workflow run instead of specifying a model.

```bash
# List all data from the latest run of a workflow (shows each item's job/step)
swamp data list --workflow test-data-fetch --json

# List data from a specific run
swamp data list --workflow test-data-fetch --run <run_id> --json

# Read one step's output; name the job and step, since several steps can
# write data with the same name
swamp data query 'workflowRunId == "<run_id>" && jobName == "<job>" && stepName == "<step>" && name == "output" && version >= 0' --select content
```

A query has no "latest run" shortcut: get the run id from
`swamp workflow history get <workflow>` or the `data list --workflow` output.
When several steps wrote the name, the deprecated `swamp data get --workflow`
returns the highest-versioned match (the first step on a tie) and warns with the
other matches.

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
   swamp data query 'modelName == "my-model" && name == "new-name"' --json
   ```
   `results` should be empty. If it has an entry, the name is taken.
2. **Rename** the data instance:
   ```bash
   swamp data rename my-model old-name new-name
   ```
3. **Confirm** the rename landed:
   ```bash
   swamp data query 'modelName == "my-model" && name == "new-name"' --json
   ```
   Should return `new-name` at version 1. `data query` matches names exactly and
   does not follow the forward reference; CEL
   `data.latest("my-model", "old-name")` resolves `old-name` to `new-name`.

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
