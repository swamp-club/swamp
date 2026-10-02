# Swamp Data Skill

Manage model data lifecycle through the CLI. All commands support `--json` for
machine-readable output.

**Verify CLI syntax:** Always run `swamp help data` to confirm exact flags
before executing — the output is structured JSON.

## Query is the primitive; list/search/versions are shortcuts

`swamp data query` is the general data-access command — it takes any CEL
predicate over artifact metadata and content, with optional projections via
`--select`. It is also how to read one item: `swamp data get` is **deprecated**
(it still works, but warns and prints the equivalent query as
`replacementQuery`). The `list`, `search`, and `versions` subcommands are
shortcuts for common queries; prefer them when your intent matches.

### Reading one item

| Read                     | Query                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest content           | `swamp data query 'modelName == "<m>" && name == "<n>"' --select content`                                                                         |
| A specific version       | `swamp data query 'modelName == "<m>" && name == "<n>" && version == 2' --select content`                                                         |
| A workflow step's output | `swamp data query 'workflowRunId == "<id>" && jobName == "<j>" && stepName == "<s>" && name == "<n>" && version >= 0' --select content`           |
| From the latest run      | `swamp data query 'workflowRunId == latestRun("<w>") && jobName == "<j>" && stepName == "<s>" && name == "<n>" && version >= 0' --select content` |
| Metadata only            | `swamp data query 'modelName == "<m>" && name == "<n>"'` (no `--select`)                                                                          |

With `--json` the output is `{"results": [...], "total": N, "limited": bool}`;
read `results[0]` (JSON content comes back parsed). For a binary item, select
`{"content": content, "contentEncoding": contentEncoding}`: `content` is base64
when `contentEncoding` is `"base64"`. An empty `results` means no such item. The
query matches the instance `name` exactly (use `specName == "<spec>"` for a spec
name); when nothing matches by name but something does by spec name,
`specNameHint.suggestedPredicate` gives the query to run.

Add `--single` to require exactly one match. With `--json` it prints that record
(or its `--select` value) on its own instead of the envelope, so scripts that
parsed `data get --json` keep parsing one object; zero or several matches exit
non-zero with code `QUERY_NO_MATCH` or `QUERY_MULTIPLE_MATCHES` instead of
reading the wrong `results[0]`. See [reference.md](reference.md#query-data) for
the fields `data get --json` has that the query record lacks.

A query returns only each item's latest version unless the predicate names
`version`. An item is one model's data name, and its latest version is the
newest one, whichever run or step wrote it. So:

- Add `version >= 0` when reading by `workflowRunId`, or a run whose item was
  written again later, by any run or step, finds nothing.
- `latestRun("<workflow>")` takes a workflow name or id as a string literal and
  resolves to its most recent run, as `data list --workflow` reads it. It works
  in `swamp data query` only, not in `data.query()` expressions.

### CLI shortcut mapping

| Shortcut                              | Underlying query                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `swamp data list <m>`                 | `swamp data query 'modelName == "<m>"'`                                                     |
| `swamp data list <m> --type resource` | `swamp data query 'modelName == "<m>" && dataType == "resource"'`                           |
| `swamp data list --workflow <w>`      | `swamp data query 'workflowRunId == latestRun("<w>") && version >= 0'`                      |
| `swamp data list --run <id>`          | `swamp data query 'workflowRunId == "<id>" && version >= 0'`                                |
| `swamp data versions <m> <n>`         | `swamp data query 'modelName == "<m>" && name == "<n>" && version >= 0' --select 'version'` |
| `swamp data search --tag env=prod`    | `swamp data query 'tags.env == "prod"'`                                                     |

The shortcut and the equivalent query run through the same catalog and return
the same `DataRecord` shape. See [references/fields.md](references/fields.md)
for the full list of queryable fields and predicate operators.

## Quick Reference

| Task                     | Command                                               |
| ------------------------ | ----------------------------------------------------- |
| Query by model           | `swamp data query 'modelName == "my-model"'`          |
| Query by type            | `swamp data query 'dataType == "resource"'`           |
| Query with projection    | `swamp data query 'modelName == "x"' --select 'name'` |
| Query by tags            | `swamp data query 'tags.env == "prod"'`               |
| Query by content         | `swamp data query 'attributes.status == "failed"'`    |
| List model data          | `swamp data list <model> --json`                      |
| List workflow data       | `swamp data list --workflow <name> --json`            |
| Read one item            | See [Reading one item](#reading-one-item)             |
| View version history     | `swamp data versions <model> <name> --json`           |
| Run garbage collection   | `swamp data gc --json`                                |
| Prune orphaned data      | `swamp data prune --force --json`                     |
| Preview prune (dry run)  | `swamp data prune --dry-run --json`                   |
| Rename data instance     | `swamp data rename <model> <old> <new>`               |
| Delete data artifact     | `swamp data delete <model> <name> --force`            |
| Delete one version       | `swamp data delete <model> <name> --version 3`        |
| Preview GC (dry run)     | `swamp data gc --dry-run --json`                      |
| GC workflow runs/outputs | `swamp run gc --dry-run`                              |
| GC runs (force)          | `swamp run gc --force`                                |

`swamp data gc` and `swamp data prune` operate on `.swamp/data/` (the data
catalog). `swamp run gc` operates on `.swamp/outputs/` (workflow-run history and
model-method outputs). Use both to reclaim full `.swamp/` storage.

See [references/concepts.md](references/concepts.md) for lifetime types, tags,
and version GC policies.

## Common Mistakes

| Don't do this                             | Do this instead                                       |
| ----------------------------------------- | ----------------------------------------------------- |
| `grep`/`find` on `.swamp/data/` files     | `swamp data query '<predicate>'`                      |
| `cat .swamp/data/.../raw \| jq`           | `swamp data query '<predicate>' --select content`     |
| `ls .swamp/data/` to list artifacts       | `swamp data list <model>`                             |
| Re-fetching data a model already produced | Use CEL: `data.latest("<name>", "<data>").attributes` |

Composing with swamp's `--json` output (e.g. piping through `jq` to reshape for
`--stdin`) is fine — the anti-pattern is bypassing swamp's data layer entirely.

For detailed walkthroughs of each operation, see [reference.md](reference.md).
