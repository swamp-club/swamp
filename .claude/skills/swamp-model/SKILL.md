---
name: swamp-model
description: >
  Work with existing swamp models — structured automation units that define
  typed schemas, methods (validate, transform, enrich), and outputs for data
  processing. Use when searching for model types, describing schemas, creating
  inputs, running or executing methods, viewing outputs, or managing lifecycle
  (edit, delete). Do NOT use when the user wants to build, create, or implement
  a custom model type, Zod schema, or TypeScript model — that is
  swamp-extension-model. Triggers on "swamp model", "model type", "model
  schema", "create input", "type search", "type describe", "run method",
  "execute method", "validation method", "transform method", "enrichment model",
  "model validate", "model delete", "model edit", "model output", "output logs",
  "output format", "CEL expression".
---

# Swamp Model Skill

Work with swamp models through the CLI.

## CRITICAL: Model Creation Rules

- **Never generate model IDs** — no `uuidgen`, `crypto.randomUUID()`, or manual
  UUIDs. Swamp assigns IDs automatically via `swamp model create`.
- **Never write a model YAML file from scratch** — always use
  `swamp model create <type> <name>` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing model file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help model` for the complete, up-to-date CLI schema.

Correct flow: `swamp model create <type> <name>` → set global args with
`--global-arg` or edit the YAML → validate → run.

## Quick Reference

| Task                | Command                                                         |
| ------------------- | --------------------------------------------------------------- |
| Search model types  | `swamp model type search [query]`                               |
| Describe a type     | `swamp model type describe <type>`                              |
| Create model input  | `swamp model create <type> <name>`                              |
| Create with args    | `swamp model create <type> <name> --global-arg key=value`       |
| Search models       | `swamp model search [query]`                                    |
| Get model details   | `swamp model get <id_or_name>`                                  |
| Edit model input    | `swamp model edit [id_or_name]`                                 |
| Delete a model      | `swamp model delete <id_or_name>`                               |
| Validate model      | `swamp model validate [id_or_name]`                             |
| Validate by label   | `swamp model validate [id_or_name] --label policy`              |
| Validate by method  | `swamp model validate [id_or_name] --method create`             |
| Evaluate input(s)   | `swamp model evaluate [id_or_name]`                             |
| Run a method        | `swamp model method run <id_or_name> <method>`                  |
| Run with inputs     | `swamp model method run <name> <method> --input key=value`      |
| Skip all checks     | `swamp model method run <name> <method> --skip-checks`          |
| Skip check by name  | `swamp model method run <name> <method> --skip-check <n>`       |
| Skip check by label | `swamp model method run <name> <method> --skip-check-label <l>` |
| Search outputs      | `swamp model output search [query]`                             |
| Get output details  | `swamp model output get <output_or_model>`                      |
| View output logs    | `swamp model output logs <output_id>`                           |
| View output data    | `swamp model output data <output_id>`                           |

## Accessing Structured Data

Use `swamp data get` to read model data (resources, files, outputs) in
structured form. Use reports for structured analysis of method executions. See
the `swamp-data` and `swamp-report` skills.

## Repository Structure

Swamp uses a dual-layer architecture:

- **Data directory (`/.swamp/`)** - Internal storage organized by entity type
- **Logical views (`/models/`)** - Human-friendly symlinked directories

```
/models/{model-name}/
  input.yaml → ../.swamp/definitions/{type}/{id}.yaml
  resource.yaml → ../.swamp/data/{type}/{id}/{specName}/latest/raw  (type=resource)
  outputs/ → ../.swamp/outputs/{type}/{id}/
  files/ → ../.swamp/data/{type}/{id}/ (filtered by type=file)
```

Use `swamp repo index` to rebuild if symlinks become out of sync.

## Search for Model Types

Find available model types in the system.

```bash
swamp model type search
swamp model type search "echo"
```

## Describe Model Types

Get the full schema and available methods for a type.

```bash
swamp model type describe command/shell
```

The output shows the type name, version, global arguments schema, resource
attributes schema, and available methods with their argument schemas.

## Create Model Inputs

```bash
swamp model create command/shell my-shell
```

Set globalArguments at creation time with `--global-arg` (repeatable):

```bash
swamp model create aws/ec2/vpc my-vpc \
  --global-arg region=us-east-1 \
  --global-arg cidrBlock=10.0.0.0/16
```

Dot notation creates nested objects:

```bash
--global-arg config.db.host=localhost --global-arg config.db.port=5432
# → globalArguments: { config: { db: { host: "localhost", port: "5432" } } }
```

After creation, edit the YAML file to set per-method `arguments` in the
`methods` section.

**Example input file:**

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-shell
version: 1
tags: {}
methods:
  execute:
    arguments:
      run: "echo 'Hello, world!'"
```

### Definition-Level Check Selection

Definitions can control which pre-flight checks run via the `checks` field:

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-vpc
version: 1
tags: {}
checks:
  require:
    - no-cidr-overlap # Must run, immune to --skip-checks CLI flags
  skip:
    - slow-api-check # Always skipped
globalArguments:
  cidrBlock: "10.0.0.0/16"
methods:
  create:
    arguments: {}
```

**Precedence rules:**

- `skip` always wins — even over `require` for the same check name
- `require` makes checks immune to `--skip-checks`, `--skip-check <name>`, and
  `--skip-check-label <label>` CLI flags (e.g., `--skip-checks` skips
  non-required checks but required checks still run)
- `require` checks still respect `appliesTo` method scoping
- `model validate` honors `skip` lists and warns on require/skip overlap;
  validation errors if a check name doesn't exist on the model type

### Model Inputs Schema

Models can define an `inputs` schema for runtime parameterization:

```yaml
id: 550e8400-e29b-41d4-a716-446655440000
name: my-deploy
version: 1
tags: {}
inputs:
  properties:
    environment:
      type: string
      enum: ["dev", "staging", "production"]
      description: Target environment
    dryRun:
      type: boolean
      default: false
  required: ["environment"]
globalArguments:
  target: ${{ inputs.environment }}
  simulate: ${{ inputs.dryRun }}
methods:
  deploy:
    arguments: {}
```

Inputs are provided at runtime with `--input` or `--input-file` and referenced
in globalArguments using `${{ inputs.<name> }}` expressions.

**Factory pattern:** Use inputs to create multiple instances from one model
definition — see
[references/scenarios.md#scenario-5](references/scenarios.md#scenario-5-factory-pattern-for-model-reuse).

## Edit a Model

**Recommended:** Use `swamp model get <name>` to get the file path, then edit
directly with the Edit tool, then validate with `swamp model validate <name>`.

**Alternative methods:**

- Interactive: `swamp model edit my-shell` (opens in system editor)
- Stdin: `cat updated.yaml | swamp model edit my-shell`

Run `swamp repo index` if search results seem stale after editing.

## Delete a Model

Delete a model and all related artifacts (data, outputs, logs).

```bash
swamp model delete my-shell
```

## Validate Model Inputs

Validate a model definition against its type schema. Use `--label` to run only
checks with a specific label, and `--method` to simulate validation for a
specific method context.

```bash
swamp model validate my-shell
swamp model validate                          # Validate all models
swamp model validate my-shell --label policy  # Only checks with label "policy"
swamp model validate my-shell --method create # Validate for a specific method
```

### IMPORTANT: Handling Validation Warnings

**When `warnings` is non-empty, STOP and ask the user before proceeding.** The
most common warning is "Environment variables detected" — this means the model's
behavior depends on env vars that may differ between machines or environments.

- If `warnings` contains env var usage, **tell the user** which fields use which
  env vars and ask if this is intentional.
- **Suggest alternatives:** separate models per environment (e.g.,
  `prod-jenkins` and `dev-jenkins` with hardcoded values), or `vault.get()` for
  sensitive values.
- **Never silently run a method** on a model with env var warnings without user
  confirmation — the data artifacts will be stored under the model name and may
  contain results from an unintended environment.

## Expression Language

Model inputs support CEL expressions using `${{ <expression> }}` syntax.
Reference types, data versioning functions, and examples are in
[references/expressions.md](references/expressions.md).

## Evaluate Model Inputs

Evaluate expressions and write results to `inputs-evaluated/`.

```bash
swamp model evaluate my-subnet
swamp model evaluate --all
```

## Run Methods

Execute a method on a model input.

```bash
swamp model method run my-shell execute
swamp model method run my-deploy create --input environment=prod
swamp model method run my-deploy create --input environment=prod --input replicas=3
swamp model method run my-deploy create --input config.timeout=30  # dot notation for nesting
swamp model method run my-deploy create --input '{"environment": "prod"}'  # JSON also supported
swamp model method run my-deploy create --input-file inputs.yaml
swamp model method run my-deploy create --last-evaluated
swamp model method run my-deploy create --skip-checks
swamp model method run my-deploy create --skip-check valid-region
swamp model method run my-deploy create --skip-check-label live
```

Pre-flight checks run automatically before mutating methods (`create`, `update`,
`delete`, `action`). Read-only methods (`sync`, `get`, etc.) do not trigger
checks.

**Environment variable warnings** are emitted before execution if the model
definition uses `${{ env.* }}` expressions. When you see these warnings in the
output, **pause and confirm with the user** that the current environment
variables are correct for the intended target. See
[Handling Validation Warnings](#important-handling-validation-warnings) above.

**Options:**

| Flag                         | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `--input <value>`            | Input values (key=value repeatable, or JSON)     |
| `--input-file <f>`           | Input values from YAML file                      |
| `--last-evaluated`           | Use previously evaluated model (skip eval)       |
| `--skip-checks`              | Skip all pre-flight checks                       |
| `--skip-check <name>`        | Skip a specific check by name (repeatable)       |
| `--skip-check-label <label>` | Skip all checks with a given label (repeatable)  |
| `--driver <driver>`          | Override execution driver (e.g. `raw`, `docker`) |

After execution, use `swamp data list <model>` to see produced data and
`swamp data get <model> <name>` to read specific data items.

## Model Outputs

Use `swamp model output search`, `output get`, `output logs`, and `output data`
to inspect method execution results. See
[references/outputs.md](references/outputs.md) for commands.

## Workflow Example

1. **Search** for the right type: `swamp model type search "shell"`
2. **Search community** if no local type: `swamp extension search <query>` — if
   a matching extension exists, install it with `swamp extension pull <package>`
   instead of building from scratch
3. **Describe** to understand the schema:
   `swamp model type describe command/shell`
4. **Create** an input file: `swamp model create command/shell my-shell`
5. **Edit** the YAML file to set `methods.execute.arguments.run`
6. **Validate** the model: `swamp model validate my-shell`
7. **Check warnings** — if the validation output has non-empty `warnings`, stop
   and ask the user before proceeding (see
   [Handling Validation Warnings](#important-handling-validation-warnings))
8. **Run** the method: `swamp model method run my-shell execute`
9. **View** the output: `swamp model output get my-shell`

## Data Ownership

Data is owned by the creating model — see
[references/data-ownership.md](references/data-ownership.md) for rules and
validation.

## Choosing the Right Approach

| Task                                                  | Approach                                  |
| ----------------------------------------------------- | ----------------------------------------- |
| New API/service integration                           | Extension model (`swamp-extension-model`) |
| Existing model missing a method                       | Extend it (`swamp-extension-model`)       |
| Reusable data pipeline (reports, analysis, summaries) | Report extension (`swamp-report`)         |
| Ad-hoc debugging or one-off data inspection           | Inline processing is fine                 |

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Repository structure            | `swamp-repo`            |
| Manage data lifecycle           | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension-model` |
| Create reports for models       | `swamp-report`          |
| Understand swamp internals      | `swamp-troubleshooting` |

## References

- **Outputs**: See [references/outputs.md](references/outputs.md) for output
  search, get, logs, and data commands
- **Examples**: See [references/examples.md](references/examples.md) for
  complete model workflows and CEL expression reference
- **Troubleshooting**: See
  [references/troubleshooting.md](references/troubleshooting.md) for common
  errors and fixes
- **Scenarios**: See [references/scenarios.md](references/scenarios.md) for
  end-to-end scenarios (shell commands, chained lookups, runtime inputs)
- **Data chaining**: See
  [references/data-chaining.md](references/data-chaining.md) for command/shell
  model examples and chaining patterns
- **Execution drivers**: See
  [references/execution-drivers.md](references/execution-drivers.md)
