# Swamp Model Skill

Work with swamp models through the CLI.

## Output Modes

- **Execution** (`method run`): Use default log output. Results are persisted in
  the datastore — use `report get --json` for structured detail (narrative,
  schema, pointers) or `data get --json` for specific resources.
- **Retrieval** (`model get`, `data get`, `report get`, `output search`): Use
  `--json` when you need structured data for action.
- **Mutation** (`model create`, `model delete`): Use `--json` to capture the
  structured result.

## Prefer Direct Execution

For most use cases, **direct type execution** is the right approach — pass
inputs at runtime without managing definition YAML files:

```bash
swamp model @<type> method run <method> <name> --input key=value
```

Inputs are automatically routed between global arguments and method arguments
using the type's schemas. See
[references/direct-execution.md](references/direct-execution.md) for details.

Use `model create` only when you need **persistent, managed definitions** — CEL
expressions in global arguments, version-controlled definition files, or shared
definitions referenced across multiple workflows.

## Model Creation Rules (when using `model create`)

- **Never generate model IDs** — no `uuidgen`, `crypto.randomUUID()`, or manual
  UUIDs. Swamp assigns IDs automatically via `swamp model create`.
- **Never write a model YAML file from scratch** — always use
  `swamp model create <type> <name> --json` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing model file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help model` for the complete, up-to-date CLI schema.

## Per-Input Disposable Instances

When a method holds the instance lock for minutes (LLM calls, long network IO),
create per-input ephemeral instances for concurrent dispatch. See
[references/disposable-instances.md](references/disposable-instances.md).

## Quick Reference

| Task                | Command                                                              |
| ------------------- | -------------------------------------------------------------------- |
| Search model types  | `swamp model type search [query] --json`                             |
| Describe a type     | `swamp model type describe <type> --compact --json`                  |
| Create model input  | `swamp model create <type> <name> --json`                            |
| Create with args    | `swamp model create <type> <name> --global-arg key=value --json`     |
| Search models       | `swamp model search [query] --json`                                  |
| Get model details   | `swamp model get <id_or_name> --json`                                |
| Edit model input    | `swamp model edit [id_or_name]`                                      |
| Delete a model      | `swamp model delete <id_or_name> --json`                             |
| Validate model      | `swamp model validate [id_or_name] --json`                           |
| Validate by label   | `swamp model validate [id_or_name] --label policy --json`            |
| Validate by method  | `swamp model validate [id_or_name] --method create --json`           |
| Evaluate input(s)   | `swamp model evaluate [id_or_name] --json`                           |
| Run a method        | `swamp model method run <id_or_name> <method>`                       |
| Run with inputs     | `swamp model method run <name> <method> --input key=value`           |
| Run from stdin      | `echo '{"k":"v"}' \| swamp model method run <name> <method> --stdin` |
| Direct type exec    | `swamp model @<type> method run <method> <name> --input k=v`         |
| Skip all checks     | `swamp model method run <name> <method> --skip-checks`               |
| Skip check by name  | `swamp model method run <name> <method> --skip-check <n>`            |
| Skip check by label | `swamp model method run <name> <method> --skip-check-label <l>`      |
| Search outputs      | `swamp model output search [query] --json`                           |
| Get output details  | `swamp model output get <output_or_model> --json`                    |
| View output logs    | `swamp model output logs <output_id> --json`                         |
| View output data    | `swamp model output data <output_id> --json`                         |
| Cancel a run        | `swamp model cancel <name>`                                          |
| Cancel all runs     | `swamp model cancel --all`                                           |
| Active runs         | `swamp run history --active`                                         |
| Recent runs         | `swamp run history`                                                  |
| Diagnose stale runs | `swamp run doctor`                                                   |

## Discover Before Shelling Out

Before reaching for raw CLI tools (`aws`, `gcloud`, `kubectl`, `curl`), check
whether a model type already wraps that API:

```bash
swamp model type search "ec2"          # find types by keyword
swamp extension search "kubernetes"    # find community extensions
swamp model type describe <type> --compact --json  # see available methods
```

If a type exists, use its methods instead of shelling out — model methods
produce versioned data, wire into workflows, and compose with CEL expressions.

For detailed walkthroughs of each operation, see [reference.md](reference.md).
