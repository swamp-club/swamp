---
name: swamp-model
description: Work with swamp models for AI-native automation. Use when searching for model types, describing model schemas, creating model inputs, running model methods, or viewing outputs. Triggers on "swamp model", "model type", "create input", "type search", "type describe", "run method", "execute method", "model validate", "model delete", "model edit", "model output", "output logs", "CEL expression", or running automation workflows.
---

# Swamp Model Skill

Work with swamp models through the CLI. All commands support `--json` for
machine-readable output.

## CRITICAL: Model Creation Rules

- **Never generate model IDs** — no `uuidgen`, `crypto.randomUUID()`, or manual
  UUIDs. Swamp assigns IDs automatically via `swamp model create`.
- **Never write a model YAML file from scratch** — always use
  `swamp model create <type> <name> --json` first, then edit the scaffold at the
  returned `path`, preserving the assigned `id`.
- **Never modify the `id` field** in an existing model file.
- **Verify CLI syntax**: If unsure about exact flags or subcommands, run
  `swamp help model` for the complete, up-to-date CLI schema.

Correct flow: `swamp model create <type> <name> --json` → edit the YAML →
validate → run.

## Quick Reference

| Task               | Command                                                  |
| ------------------ | -------------------------------------------------------- |
| Search model types | `swamp model type search [query] --json`                 |
| Describe a type    | `swamp model type describe <type> --json`                |
| Create model input | `swamp model create <type> <name> --json`                |
| Search models      | `swamp model search [query] --json`                      |
| Get model details  | `swamp model get <id_or_name> --json`                    |
| Edit model input   | `swamp model edit [id_or_name]`                          |
| Delete a model     | `swamp model delete <id_or_name> --json`                 |
| Validate model     | `swamp model validate [id_or_name] --json`               |
| Evaluate input(s)  | `swamp model evaluate [id_or_name] --json`               |
| Run a method       | `swamp model method run <id_or_name> <method> --json`    |
| Run with inputs    | `swamp model method run <name> <method> --input '{}' -j` |
| Search outputs     | `swamp model output search [query] --json`               |
| Get output details | `swamp model output get <output_or_model> --json`        |
| View output logs   | `swamp model output logs <output_id> --json`             |
| View output data   | `swamp model output data <output_id> --json`             |

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
swamp model type search --json
swamp model type search "echo" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    { "raw": "command/shell", "normalized": "command/shell" }
  ]
}
```

## Describe Model Types

Get the full schema and available methods for a type.

```bash
swamp model type describe command/shell --json
```

**Output shape:**

```json
{
  "type": { "raw": "command/shell", "normalized": "command/shell" },
  "version": "2026.02.09.1",
  "globalArguments": {/* JSON Schema */},
  "resourceAttributesSchema": {/* JSON Schema */},
  "methods": [
    {
      "name": "execute",
      "description": "Execute a shell command and capture output",
      "arguments": {/* JSON Schema */}
    }
  ]
}
```

**Key fields:**

- `globalArguments` - JSON Schema for input YAML `globalArguments` section
- `methods` - Available operations with their per-method `arguments` schemas

## Create Model Inputs

```bash
swamp model create command/shell my-shell --json
```

**Output shape:**

```json
{
  "path": "definitions/command/shell/my-shell.yaml",
  "type": "command/shell",
  "name": "my-shell"
}
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

**Recommended:** Use `swamp model get <name> --json` to get the file path, then
edit directly with the Edit tool, then validate with
`swamp model validate <name> --json`.

**Alternative methods:**

- Interactive: `swamp model edit my-shell` (opens in system editor)
- Stdin: `cat updated.yaml | swamp model edit my-shell --json`

Run `swamp repo index` if search results seem stale after editing.

## Delete a Model

Delete a model and all related artifacts (data, outputs, logs).

```bash
swamp model delete my-shell --json
```

**Output shape:**

```json
{
  "deleted": true,
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "artifactsDeleted": {
    "outputs": 5,
    "dataItems": 3
  }
}
```

## Validate Model Inputs

Validate a model definition against its type schema.

```bash
swamp model validate my-shell --json
swamp model validate --json  # Validate all models
```

**Output shape (single):**

```json
{
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "type": "command/shell",
  "validations": [
    { "name": "Definition schema validation", "passed": true },
    { "name": "Method arguments validation", "passed": true },
    { "name": "Expression syntax valid", "passed": true }
  ],
  "passed": true
}
```

**Output shape (all):**

```json
{
  "models": [
    { "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", "modelName": "my-shell", "validations": [...], "passed": true }
  ],
  "totalPassed": 5,
  "totalFailed": 1,
  "passed": false
}
```

## Expression Language

Model inputs support CEL expressions using `${{ <expression> }}` syntax.
Reference types, data versioning functions, and examples are in
[references/expressions.md](references/expressions.md).

## Evaluate Model Inputs

Evaluate expressions and write results to `inputs-evaluated/`.

```bash
swamp model evaluate my-subnet --json
swamp model evaluate --all --json
```

**Output shape:**

```json
{
  "evaluatedInputs": [
    {
      "name": "my-subnet",
      "type": "aws/subnet",
      "path": "inputs-evaluated/aws/subnet/my-subnet.yaml"
    }
  ]
}
```

## Run Methods

Execute a method on a model input.

```bash
swamp model method run my-shell execute --json
swamp model method run my-deploy create --input '{"environment": "prod"}' --json
swamp model method run my-deploy create --input-file inputs.yaml --json
swamp model method run my-deploy create --last-evaluated --json
```

**Options:**

| Flag               | Description                                |
| ------------------ | ------------------------------------------ |
| `--input <json>`   | Input values as JSON string                |
| `--input-file <f>` | Input values from YAML file                |
| `--last-evaluated` | Use previously evaluated model (skip eval) |

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "method": "execute",
  "status": "succeeded",
  "duration": 150,
  "artifacts": {
    "resource": ".swamp/data/command/shell/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/result/1/raw"
  }
}
```

## Model Outputs

### Search Outputs

Find method execution outputs.

```bash
swamp model output search --json
swamp model output search "my-shell" --json
```

**Output shape:**

```json
{
  "query": "",
  "results": [
    {
      "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
      "modelName": "my-shell",
      "method": "execute",
      "status": "succeeded",
      "createdAt": "2025-01-15T10:30:00Z"
    }
  ]
}
```

### Get Output Details

Get full details of a specific output or latest output for a model.

```bash
swamp model output get d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
swamp model output get my-shell --json  # Latest output for model
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "modelId": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "modelName": "my-shell",
  "type": "command/shell",
  "method": "execute",
  "status": "succeeded",
  "startedAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:00.150Z",
  "artifacts": [
    { "type": "resource", "path": "..." }
  ]
}
```

### View Output Logs

Get log content from a method execution.

```bash
swamp model output logs d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "logs": "Executing shell command...\nHello, world!\nCommand completed successfully."
}
```

### View Output Data

Get data artifact content from a method execution.

```bash
swamp model output data d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5 --json
```

**Output shape:**

```json
{
  "outputId": "d1e2f3a4-b5c6-4d7e-f8a9-b0c1d2e3f4a5",
  "data": {
    "exitCode": 0,
    "command": "echo 'Hello, world!'",
    "executedAt": "2025-01-15T10:30:00Z"
  }
}
```

## Workflow Example

1. **Search** for the right type: `swamp model type search "shell" --json`
2. **Describe** to understand the schema:
   `swamp model type describe command/shell --json`
3. **Create** an input file: `swamp model create command/shell my-shell --json`
4. **Edit** the YAML file to set `methods.execute.arguments.run`
5. **Validate** the model: `swamp model validate my-shell --json`
6. **Run** the method: `swamp model method run my-shell execute --json`
7. **View** the output: `swamp model output get my-shell --json`

## Data Ownership

Data is owned by the creating model — see
[references/data-ownership.md](references/data-ownership.md) for rules and
validation.

## When to Use Other Skills

| Need                            | Use Skill               |
| ------------------------------- | ----------------------- |
| Create/run workflows            | `swamp-workflow`        |
| Manage secrets                  | `swamp-vault`           |
| Repository structure            | `swamp-repo`            |
| Manage data lifecycle           | `swamp-data`            |
| Create custom TypeScript models | `swamp-extension-model` |

## References

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
- **Model design**: See [design/models.md](design/models.md) for data structures
  and concepts
