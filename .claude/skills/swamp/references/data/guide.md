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

| Task                    | Command                                               |
| ----------------------- | ----------------------------------------------------- |
| Query by model          | `swamp data query 'modelName == "my-model"'`          |
| Query by type           | `swamp data query 'dataType == "resource"'`           |
| Query with projection   | `swamp data query 'modelName == "x"' --select 'name'` |
| Query by tags           | `swamp data query 'tags.env == "prod"'`               |
| Query by content        | `swamp data query 'attributes.status == "failed"'`    |
| List model data         | `swamp data list <model> --json`                      |
| List workflow data      | `swamp data list --workflow <name> --json`            |
| Get specific data       | `swamp data get <model> <name> --json`                |
| Get metadata only       | `swamp data get <model> <name> --no-content --json`   |
| Get data via workflow   | `swamp data get --workflow <name> <data_name> --json` |
| View version history    | `swamp data versions <model> <name> --json`           |
| Run garbage collection  | `swamp data gc --json`                                |
| Prune orphaned data     | `swamp data prune --force --json`                     |
| Preview prune (dry run) | `swamp data prune --dry-run --json`                   |
| Rename data instance    | `swamp data rename <model> <old> <new>`               |
| Delete data artifact    | `swamp data delete <model> <name> --force`            |
| Delete one version      | `swamp data delete <model> <name> --version 3`        |
| Preview GC (dry run)    | `swamp data gc --dry-run --json`                      |

See [references/concepts.md](references/concepts.md) for lifetime types, tags,
and version GC policies.

For detailed walkthroughs of each operation, see [reference.md](reference.md).
