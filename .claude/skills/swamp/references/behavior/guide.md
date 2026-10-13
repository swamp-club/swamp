# Swamp Behavior Guide

Work with swamp behaviors (formerly called models) through the CLI. Every
`swamp model …` spelling still works; see
[reference.md#compatibility](reference.md#compatibility).

## Output Modes

- **Execution** (`behavior run`): Use default log output. Results are persisted
  in the datastore — use `report get --json` for structured detail (narrative,
  schema, pointers) or `data query --json` for specific resources.
- **Retrieval** (`behavior get`, `data query`, `report get`, `output search`):
  Use `--json` when you need structured data for action.
- **Mutation** (`behavior create`, `behavior delete`): Use `--json` to capture
  the structured result.

## Prefer Direct Execution

For most use cases, **direct type execution** is the right approach — pass
inputs at runtime without managing definition YAML files:

```bash
swamp behavior run @<type> <method> <name> --input key=value
```

Inputs are automatically routed between global arguments and method arguments
using the type's schemas. See
[references/direct-execution.md](references/direct-execution.md) for details.

Use `behavior create` only when you need **persistent, managed definitions** —
CEL expressions in global arguments, version-controlled definition files, or
shared definitions referenced across multiple workflows.

## Definition Creation Rules (when using `behavior create`)

- **Behavior names must be lowercase alphanumeric with hyphens or underscores**
  (e.g. `my-server`, `prod_vpc`). Max 64 characters. Names are used as the
  filename on disk (`models/{type}/my-server.yaml`).
- **Never generate behavior IDs** — no `uuidgen`, `crypto.randomUUID()`, or
  manual UUIDs. Swamp assigns IDs automatically via `swamp behavior create`.
- **Never write a definition YAML file from scratch** — always use
  `swamp behavior create <type> <name> --json` first, then edit the scaffold at
  the returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing definition file.
- **Verify CLI syntax**: Always run `swamp help behavior` to confirm exact flags
  before executing — the output is structured JSON.

## Per-Input Disposable Instances

When a method holds the instance lock for minutes (LLM calls, long network IO),
create per-input ephemeral instances for concurrent dispatch. See
[references/disposable-instances.md](references/disposable-instances.md).

## Quick Reference

| Task                | Command                                                             |
| ------------------- | ------------------------------------------------------------------- |
| Search types        | `swamp behavior type search [query] --json`                         |
| Describe a type     | `swamp behavior type describe <type> --compact --json`              |
| Create definition   | `swamp behavior create <type> <name> --json`                        |
| Create with args    | `swamp behavior create <type> <name> --global-arg key=value --json` |
| Search behaviors    | `swamp behavior search [query] --json`                              |
| Get behavior        | `swamp behavior get <id_or_name> --json`                            |
| Edit definition     | `swamp behavior edit [id_or_name]`                                  |
| Delete a behavior   | `swamp behavior delete <id_or_name> --json`                         |
| Validate behavior   | `swamp behavior validate [id_or_name] --json`                       |
| Validate by label   | `swamp behavior validate [id_or_name] --label policy --json`        |
| Validate by method  | `swamp behavior validate [id_or_name] --method create --json`       |
| Evaluate input(s)   | `swamp behavior evaluate [id_or_name] --json`                       |
| Run a method        | `swamp behavior run <id_or_name> <method>`                          |
| Run with inputs     | `swamp behavior run <name> <method> --input key=value`              |
| Run from stdin      | `echo '{"k":"v"}' \| swamp behavior run <name> <method> --stdin`    |
| Direct type exec    | `swamp behavior run @<type> <method> <name> --input k=v`            |
| Skip all checks     | `swamp behavior run <name> <method> --skip-checks`                  |
| Skip check by name  | `swamp behavior run <name> <method> --skip-check <n>`               |
| Skip check by label | `swamp behavior run <name> <method> --skip-check-label <l>`         |
| Search outputs      | `swamp behavior output search [query] --json`                       |
| Get output details  | `swamp behavior output get <output_or_model> --json`                |
| View output logs    | `swamp behavior output logs <output_id> --json`                     |
| View output data    | `swamp behavior output data <output_id> --json`                     |
| Cancel a run        | `swamp behavior cancel <name>`                                      |
| Cancel all runs     | `swamp behavior cancel --all`                                       |
| Active runs         | `swamp run history --active`                                        |
| Recent runs         | `swamp run history`                                                 |
| Diagnose stale runs | `swamp run doctor`                                                  |
| Preview run GC      | `swamp run gc --dry-run`                                            |
| Run GC (outputs)    | `swamp run gc --force`                                              |
| Run GC (custom age) | `swamp run gc --older-than 7d`                                      |

## Discover Before Shelling Out

Before reaching for raw CLI tools (`aws`, `gcloud`, `kubectl`, `curl`), check
whether a behavior type already wraps that API:

```bash
swamp behavior type search "ec2"          # find types by keyword
swamp extension search "kubernetes"    # find community extensions
swamp behavior type describe <type> --compact --json  # see available methods
```

If a type exists, use its methods instead of shelling out — methods produce
versioned data, wire into workflows, and compose with CEL expressions.

For detailed walkthroughs of each operation, see [reference.md](reference.md).
